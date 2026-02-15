After completing the review, you MUST end your response with an explicit status marker.

Severity classification:
- **HIGH** and **MEDIUM** findings are **blocking** — they must be fixed before the change can proceed.
- **LOW** findings are **non-blocking** — they are advisory improvements left to the implementer's judgement.

Rules:
- If there are any HIGH or MEDIUM findings: output `[STATUS: fail]` and include `[FAILURE_REASON: ...]` listing the HIGH/MEDIUM findings.
- If there are only LOW findings or no findings: output `[STATUS: success]`.
- Always include exactly one status marker.
