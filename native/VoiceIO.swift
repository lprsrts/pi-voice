// Native macOS audio for the Pi voice extension: Apple's VoiceProcessingIO unit
// (the echo canceller FaceTime uses) on the system default input/output.
//
//   voice-io session --in-rate R --out-rate R [--aec on|off]
//     stdin  : PCM s16le mono at out-rate -> speaker
//     stdout : PCM s16le mono at in-rate  <- mic (echo-cancelled unless --aec off)
//     fd 3   : control lines: "flush" (drop queued playback), "mute 0|1"
//     fd 4   : "played <gen> <bytes>" as the speaker renders sent audio; bytes
//             count real pops since the last flush (underrun zero-fill does not
//             count) and gen bumps on each flush, so stale in-flight reports
//             from before a flush stay distinguishable from fresh ones
//     stderr : "ready", "route {json}" after a default-device switch, or "error: ..."
//   voice-io play --rate R              stdin PCM -> speaker, exits when played
//   voice-io record --rate R --seconds S [--aec on|off]   mic PCM -> stdout
//   voice-io devices                    {"input": ..., "output": ...} on stdout
//
// One unit owns both directions, so the canceller sees exactly what plays. It
// follows default-device changes by reinitializing. Built on demand by native.ts.

import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(("error: " + message + "\n").data(using: .utf8)!)
  exit(1)
}

func check(_ status: OSStatus, _ what: String) {
  if status != noErr { fail("\(what) failed (OSStatus \(status))") }
}

func say(_ line: String) { FileHandle.standardError.write((line + "\n").data(using: .utf8)!) }

// ---------- arguments ----------

var argv = Array(CommandLine.arguments.dropFirst())
let mode = argv.isEmpty ? "" : argv.removeFirst()
var options: [String: String] = [:]
while !argv.isEmpty {
  let key = argv.removeFirst()
  guard key.hasPrefix("--"), !argv.isEmpty else { fail("bad argument \(key)") }
  options[String(key.dropFirst(2))] = argv.removeFirst()
}

func rate(_ name: String) -> Double {
  guard let raw = options[name], let value = Double(raw), value >= 8000, value <= 48000 else { fail("--\(name) must be 8000...48000") }
  return value
}
let aec: Bool = {
  switch options["aec"] ?? "on" {
  case "on": return true
  case "off": return false
  default: fail("--aec must be on or off")
  }
}()

// ---------- default devices ----------

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var device = AudioObjectID(0)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
  return device
}

func deviceName(_ device: AudioObjectID) -> String {
  var address = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var name: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard device != 0, AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name) == noErr, let name else { return "none" }
  return name.takeRetainedValue() as String
}

func routeJSON() -> String {
  let route = ["input": deviceName(defaultDevice(kAudioHardwarePropertyDefaultInputDevice)),
               "output": deviceName(defaultDevice(kAudioHardwarePropertyDefaultOutputDevice))]
  return String(data: try! JSONSerialization.data(withJSONObject: route, options: [.sortedKeys]), encoding: .utf8)!
}

if mode == "devices" { print(routeJSON()); exit(0) }

// ---------- shared plumbing ----------

/// Bounded byte FIFO shared between a pipe thread and the audio thread.
final class Fifo {
  private var data = [UInt8]()
  private var head = 0
  private let lock = NSLock()
  private let capacity: Int
  init(capacity: Int) { self.capacity = capacity }

  func push(_ bytes: UnsafeRawBufferPointer) {
    lock.lock(); defer { lock.unlock() }
    data.append(contentsOf: bytes)
    let excess = data.count - head - capacity
    if excess > 0 { head += excess + (excess & 1) } // keep sample alignment
    if head > 65536 { data.removeFirst(head); head = 0 }
  }

  /// Copies up to `count` bytes, zero-filling any shortfall. Returns bytes copied.
  @discardableResult
  func pop(into out: UnsafeMutableRawPointer, count: Int) -> Int {
    lock.lock(); defer { lock.unlock() }
    let n = min(count, data.count - head)
    if n > 0 { data.withUnsafeBytes { out.copyMemory(from: $0.baseAddress! + head, byteCount: n) } }
    if n < count { memset(out + n, 0, count - n) }
    head += n
    return n
  }

  func clear() { lock.lock(); data.removeAll(keepingCapacity: true); head = 0; lock.unlock() }
  var count: Int { lock.lock(); defer { lock.unlock() }; return data.count - head }
}

// Playout position of the audio the speaker actually rendered, so the parent can
// time captions to what is heard rather than to what it wrote down the pipe.
var playedGen = 0
var playedBytes = 0
let playedLock = NSLock()
let playedReady = DispatchSemaphore(value: 0)

func pcm16(_ rate: Double) -> AudioStreamBasicDescription {
  AudioStreamBasicDescription(
    mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
    mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
    mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
}

func writeAll(_ bytes: UnsafeRawPointer, _ count: Int) {
  var offset = 0
  while offset < count {
    let written = write(1, bytes + offset, count - offset)
    if written <= 0 { exit(0) } // parent closed the pipe
    offset += written
  }
}

func writeLine(_ fd: Int32, _ line: String) {
  var text = line
  text.withUTF8 { buffer in
    var offset = 0
    while offset < buffer.count {
      let n = write(fd, buffer.baseAddress! + offset, buffer.count - offset)
      if n <= 0 { exit(0) } // parent closed the pipe
      offset += n
    }
  }
}

/// Reads stdin into the FIFO; EOF runs `done` (the parent is gone or finished).
func pumpStdin(into fifo: Fifo, done: @escaping () -> Void) {
  Thread.detachNewThread {
    let chunk = UnsafeMutableRawPointer.allocate(byteCount: 8192, alignment: 2)
    while true {
      let n = read(0, chunk, 8192)
      if n <= 0 { done(); return }
      fifo.push(UnsafeRawBufferPointer(start: chunk, count: n))
    }
  }
}

let busOutput: AudioUnitElement = 0, busInput: AudioUnitElement = 1
var unit: AudioUnit!

func newUnit(_ subtype: OSType) -> AudioUnit {
  var description = AudioComponentDescription(
    componentType: kAudioUnitType_Output, componentSubType: subtype,
    componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
  guard let component = AudioComponentFindNext(nil, &description) else { fail("audio unit \(subtype) unavailable") }
  var instance: AudioUnit?
  check(AudioComponentInstanceNew(component, &instance), "AudioComponentInstanceNew")
  return instance!
}

func setRenderSource(_ fifo: Fifo) {
  let box = Unmanaged.passRetained(fifo).toOpaque()
  var render = AURenderCallbackStruct(inputProc: { refCon, _, _, _, frames, ioData in
    let fifo = Unmanaged<Fifo>.fromOpaque(refCon).takeUnretainedValue()
    guard let buffers = UnsafeMutableAudioBufferListPointer(ioData) else { return noErr }
    for buffer in buffers where buffer.mData != nil {
      playedLock.lock()
      let n = fifo.pop(into: buffer.mData!, count: Int(frames) * 2)
      if n > 0 { playedBytes += n }
      playedLock.unlock()
      if n > 0 { playedReady.signal() } // the zero-filled shortfall of an underrun never counts
    }
    return noErr
  }, inputProcRefCon: box)
  check(AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, busOutput,
                             &render, UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "render callback")
}

// ---------- play: plain default output, no microphone ----------

if mode == "play" {
  let playRate = rate("rate")
  let fifo = Fifo(capacity: Int(playRate) * 2 * 120)
  unit = newUnit(kAudioUnitSubType_DefaultOutput)
  var format = pcm16(playRate)
  check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, busOutput,
                             &format, UInt32(MemoryLayout<AudioStreamBasicDescription>.size)), "speaker format")
  setRenderSource(fifo)
  check(AudioUnitInitialize(unit), "AudioUnitInitialize")
  pumpStdin(into: fifo) {
    check(AudioOutputUnitStart(unit), "AudioOutputUnitStart")
    while fifo.count > 0 { usleep(20000) }
    usleep(150000) // let the device drain its own buffer
    exit(0)
  }
  dispatchMain()
}

// ---------- session / record: VoiceProcessingIO ----------

guard mode == "session" || mode == "record" else { fail("usage: voice-io session|play|record|devices [options]") }

// Without TCC consent the unit silently delivers zeros; fail loudly instead.
let permission = DispatchSemaphore(value: 0)
var granted = false
AVCaptureDevice.requestAccess(for: .audio) { ok in granted = ok; permission.signal() }
permission.wait()
if !granted { fail("microphone permission denied (System Settings > Privacy & Security > Microphone)") }

let inRate = mode == "session" ? rate("in-rate") : rate("rate")
// VoiceProcessingIO needs one rate on both buses (-10875 otherwise): run the
// unit at the playback rate and resample the mic to the uplink rate.
let unitRate = mode == "session" ? rate("out-rate") : inRate
let playback = Fifo(capacity: Int(unitRate) * 2 * 2) // caller paces in real time; 2s caps any backlog
let captured = Fifo(capacity: Int(unitRate) * 2 * 2)
let capturedReady = DispatchSemaphore(value: 0)
let scratch = UnsafeMutableRawPointer.allocate(byteCount: 1 << 16, alignment: 16)

func configureVoiceUnit() {
  var one: UInt32 = 1
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, busInput, &one, 4), "enable input")
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, busOutput, &one, 4), "enable output")
  let size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  var format = pcm16(unitRate)
  check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, busOutput, &format, size), "speaker format")
  check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, busInput, &format, size), "mic format")
  var bypass: UInt32 = aec ? 0 : 1
  check(AudioUnitSetProperty(unit, kAUVoiceIOProperty_BypassVoiceProcessing, kAudioUnitScope_Global, 0, &bypass, 4), "voice processing bypass")
  // Voice processing ducks other apps' audio by default; keep that to a minimum.
  if #available(macOS 14.0, *) {
    var ducking = AUVoiceIOOtherAudioDuckingConfiguration(mEnableAdvancedDucking: false, mDuckingLevel: .min)
    AudioUnitSetProperty(unit, kAUVoiceIOProperty_OtherAudioDuckingConfiguration, kAudioUnitScope_Global, 0,
                         &ducking, UInt32(MemoryLayout<AUVoiceIOOtherAudioDuckingConfiguration>.size))
  }
  setRenderSource(playback)
  var input = AURenderCallbackStruct(inputProc: { _, flags, timestamp, bus, frames, _ in
    let bytes = Int(frames) * 2
    guard bytes <= 1 << 16 else { return noErr }
    var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes), mData: scratch))
    if AudioUnitRender(unit, flags, timestamp, bus, frames, &list) == noErr {
      captured.push(UnsafeRawBufferPointer(start: scratch, count: Int(list.mBuffers.mDataByteSize)))
      capturedReady.signal()
    }
    return noErr
  }, inputProcRefCon: nil)
  check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, busInput,
                             &input, UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "input callback")
}

var muted: UInt32 = 0
func startVoiceUnit() {
  unit = newUnit(kAudioUnitSubType_VoiceProcessingIO)
  configureVoiceUnit()
  check(AudioUnitInitialize(unit), "AudioUnitInitialize")
  AudioUnitSetProperty(unit, kAUVoiceIOProperty_MuteOutput, kAudioUnitScope_Global, busInput, &muted, 4)
  check(AudioOutputUnitStart(unit), "AudioOutputUnitStart")
}

func stopVoiceUnit() {
  guard let current = unit else { return }
  AudioOutputUnitStop(current)
  AudioUnitUninitialize(current)
  AudioComponentInstanceDispose(current)
}

startVoiceUnit()
signal(SIGPIPE, SIG_IGN)

// Default-device switches (AirPods in or out): rebuild the unit on the new
// route, debounced because macOS changes input and output separately.
let audioQueue = DispatchQueue(label: "voice-io.route")
var lastRoute = routeJSON()
var pendingRestart: DispatchWorkItem?
let onRouteChange: AudioObjectPropertyListenerBlock = { _, _ in
  pendingRestart?.cancel()
  let work = DispatchWorkItem {
    let route = routeJSON()
    guard route != lastRoute else { return }
    lastRoute = route
    stopVoiceUnit()
    startVoiceUnit()
    say("route \(route)")
  }
  pendingRestart = work
  audioQueue.asyncAfter(deadline: .now() + 0.3, execute: work)
}
for selector in [kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice] {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, audioQueue, onRouteChange)
}

// Captured mic audio -> (resample) -> stdout, off the audio thread.
let recordLimit = mode == "record" ? Int((Double(options["seconds"] ?? "") ?? 0) * inRate) * 2 : Int.max
if mode == "record" && recordLimit <= 0 { fail("--seconds must be positive") }
Thread.detachNewThread {
  let maxFrames = AVAudioFrameCount(1 << 15)
  let unitFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: unitRate, channels: 1, interleaved: true)!
  let uplinkFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: inRate, channels: 1, interleaved: true)!
  let converter = inRate == unitRate ? nil : AVAudioConverter(from: unitFormat, to: uplinkFormat)
  let source = AVAudioPCMBuffer(pcmFormat: unitFormat, frameCapacity: maxFrames)!
  let resampled = AVAudioPCMBuffer(pcmFormat: uplinkFormat, frameCapacity: maxFrames)!
  var remaining = recordLimit

  func emit(_ bytes: UnsafeRawPointer, _ count: Int) {
    let n = min(count, remaining)
    writeAll(bytes, n)
    remaining -= n
    if remaining == 0 { stopVoiceUnit(); exit(0) }
  }

  while true {
    capturedReady.wait()
    let n = min(captured.count, Int(maxFrames) * 2) & ~1
    if n == 0 { continue }
    let samples = source.int16ChannelData![0]
    captured.pop(into: samples, count: n)
    guard let converter else { emit(samples, n); continue }
    source.frameLength = AVAudioFrameCount(n / 2)
    var fed = false
    resampled.frameLength = 0
    var error: NSError?
    converter.convert(to: resampled, error: &error) { _, status in
      if fed { status.pointee = .noDataNow; return nil }
      fed = true; status.pointee = .haveData; return source
    }
    if let error { fail("resampling failed: \(error.localizedDescription)") }
    emit(resampled.int16ChannelData![0], Int(resampled.frameLength) * 2)
  }
}

if mode == "session" {
  pumpStdin(into: playback) { stopVoiceUnit(); exit(0) }

  // Playout reports on fd 4 (optional; absent when run by hand): the device's
  // own position in the audio sent down stdin, generation-scoped per flush.
  if fcntl(4, F_GETFD) != -1 {
    Thread.detachNewThread {
      var lastGen = -1, lastBytes = -1
      while true {
        playedReady.wait()
        playedLock.lock()
        let gen = playedGen, bytes = playedBytes
        playedLock.unlock()
        if gen == lastGen && bytes == lastBytes { continue } // coalesce extra signals
        lastGen = gen
        lastBytes = bytes
        writeLine(4, "played \(gen) \(bytes)\n")
      }
    }
  }

  // Control lines on fd 3 (optional; absent when run by hand).
  if fcntl(3, F_GETFD) != -1 {
    Thread.detachNewThread {
      let control = FileHandle(fileDescriptor: 3)
      var pending = ""
      while true {
        let data = control.availableData
        if data.isEmpty { return }
        pending += String(decoding: data, as: UTF8.self)
        while let newline = pending.firstIndex(of: "\n") {
          let line = pending[..<newline].trimmingCharacters(in: .whitespaces)
          pending = String(pending[pending.index(after: newline)...])
          if line == "flush" {
            playedLock.lock()
            playback.clear()
            playedGen += 1
            playedBytes = 0
            playedLock.unlock()
          }
          else if line.hasPrefix("mute ") {
            let value: UInt32 = line.hasSuffix("1") ? 1 : 0
            audioQueue.async {
              muted = value
              AudioUnitSetProperty(unit, kAUVoiceIOProperty_MuteOutput, kAudioUnitScope_Global, busInput, &muted, 4)
            }
          }
        }
      }
    }
  }
}

say("ready")
dispatchMain()
