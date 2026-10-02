# Sprint 24 retrospective

Independent fault injection exposed attribution tests that accepted a forbidden ingest change.
Independent diff review walked erasure with default request logging and found that DELETE
could recreate the erased user’s event, mutate the buffer on refusal, and log a resolver error.
Both findings were fixed and their defects were demonstrated by failing tests.

The initial erasure fixture excluded the API prefix, so its socket coverage missed the default
middleware interaction. The shipped-path rule earned its place; a socket alone was insufficient.
Replace the socket-only HTTP acceptance description in `.xp/system.md` with an instruction to
exercise every changed endpoint with default request capture. Excluded-prefix fixtures become
supplemental evidence. No additional constraint is added.

Database port collisions caused avoidable runner retries. Isolated worktree ports resolved them;
shared bootstrap tooling is outside this release and is explicitly dropped from this sprint.
An empty continuation commit overrode the hook path; lead reran the actual fast, constraint,
and formatting checks. The existing no-bypass rule remains in force.

Archive the SDK double-hash tradeoff note: committed documentation and its live test preserve it.
Archive the release metadata note: all manifests, the configured version wall and release notes
now name 0.1.0. No new debt is retained. Sprint 25 remains unscheduled here.
