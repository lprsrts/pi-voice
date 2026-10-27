# Bounded automatic reconnects

Each GPT-Live connection is billed by the minute, so voice reconnects by itself only when it has something to say, and at most once per result. A connection lost while Pi works is treated like auto-pause: Pi keeps working and voice comes back with the result. A session is considered lost when it closes abnormally, sends no data for 10 s (it normally streams about every 100 ms, silence included; not checked while muted, when it sends nothing), or leaves an update unacknowledged for 8 s (acknowledgements normally take about a second). If a result was given to a lost session but not yet said, voice reconnects at once to say it, once. Errors that mean a refused session or a bad key are not retried.

## Considered Options

Reconnecting with backoff on every drop (as Codex and voice frameworks do) was rejected: each retry is a new billed session and needs a list of errors not to retry, while waiting for Pi's result already covers what the user is waiting for.
