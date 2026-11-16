# Async Quality Observer Design Note

## Purpose

Add an optional, non-blocking review of low-tier responses. The review should not
delay the user's answer. It should produce routing signals for later turns.

## Flow

1. A low-tier response completes.
2. The router snapshots the request, final answer, and relevant evidence.
3. A background task sends the snapshot to Jev.
4. The task stores a review result with session, branch, and turn identifiers.
5. A later user request may use that result to choose a higher tier.

The observer does not modify the completed response. It does not start a
correction automatically.

## Review questions

Ask Jev two narrow questions about the snapshot:

- Does the answer claim that the requested work is complete?
- Do the available results support, contradict, or leave that claim unverified?

Keep `insufficient evidence` as a distinct outcome. Missing evidence is not proof
of failure.

## Latency protection

- Hard timeout: 3 seconds.
- Abort signal: cancel on timeout, shutdown, or new user input.
- Bounded input: maximum 1,000 characters.
- Concurrency limit: 1 review at a time.
- Circuit breaker: 3 consecutive failures disable review for 10 minutes.
- Graceful degradation: a failed or timed-out review returns `unknown`.
- Sampling: review 20 percent of low-tier turns during the pilot.
- Cache: skip review when the same evidence was already reviewed.

## Routing influence

- Use only results available when routing starts.
- Apply review signals only to the same task or a clear continuation.
- Prefer medium when a signal indicates a likely incomplete low-tier answer.
- Keep manual pins and budget checks above review signals.
- Expire review signals when the task changes or after a small number of turns.
- Show when a review signal changed a routing decision.

## Pilot

- Observe only. Do not change routing.
- Collect 50 to 100 low-tier reviews.
- Measure cost, latency, and false positive rate.
- Use the results to choose thresholds before enabling routing influence.
