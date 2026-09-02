/**
 * The architecture documentation page: a guided tour of msrouter (gateway,
 * Director, queues, Kafka, Slack, RAG, the Node.js concurrency model, the
 * flat-file data layer) plus how this web console itself is built. All facts
 * are drawn from the actual code and docs/adr/*. Verified by a smoke test so
 * restructures cannot silently drop a section.
 */

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-xl font-semibold tracking-tight text-slate-100">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-300">{children}</div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[0.85em] text-cyan-300">
      {children}
    </code>
  );
}

const REPO_URL = 'https://github.com/mstaszew-dev/msrouter';

export function AboutPage(): React.JSX.Element {
  return (
    <div className="max-w-4xl space-y-10">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-100">
          msrouter, explained
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          How the gateway works, how this console is built, and why each piece
          looks the way it does.
        </p>
      </header>

      <Section id="what" title="What msrouter is">
        <p>
          msrouter is a local, outbound API gateway for LLMs. Any OpenAI-compatible client can
          point at <Code>http://localhost:8787/api/v1</Code> and talk to it as if it were the
          OpenAI API; msrouter forwards the request across a pool of OpenRouter free-tier keys
          (rotating a key out of the pool on 401/402/403/429) and then walks a fallback chain:
          OpenAI, ZAI (GLM), TokenRouter, OpenCode Zen, a local llama-server or LM Studio, and an
          Ollama instance on another machine over Tailscale. The goal is to maximize free-tier LLM
          availability without managing keys or models per provider.
        </p>
        <p>
          So is it an outbound gateway, a reverse proxy, or an LLM proxy? Honestly, all three
          descriptions overlap here, and the precise framing is: it is a <strong>reverse
          proxy</strong> in the sense that clients speak one stable API and the gateway fans the
          request out to upstreams on their behalf; it is an <strong>outbound gateway</strong> in
          the sense that all traffic leaves towards LLM providers (nothing is exposed publicly;
          the gateway binds to localhost); and "proxy for LLMs" is the informal summary of the
          same thing. What it is <em>not</em> is a generic HTTP proxy: it understands exactly one
          surface (chat completions, models, health, a read-only GraphQL endpoint) and adds
          domain logic a dumb proxy cannot, like key rotation, alias expansion, and per-provider
          retry classification.
        </p>
        <p>
          It is also not an inbound gateway: it terminates on localhost only, and everything it
          supervises (a job-search campaign agent, a Kafka broker, a Chrome DevTools endpoint,
          Playwright MCP) runs on the same machine.
        </p>
      </Section>

      <Section id="director" title="The Director">
        <p>
          Alongside the gateway runs a supervisory agent, the Director (
          <Code>src/director/</Code>). It does not route LLM requests; it routes{' '}
          <strong>decisions</strong> in a loop: observe (tail the campaign's{' '}
          <Code>events.jsonl</Code> and <Code>tracker.json</Code>), classify with deterministic
          rules (good apply, risky apply, duplicate risk, stale campaign), propose patches via a
          read-only LLM agent loop, wait for a human approval on Slack, and finally apply approved
          patches to a key=value overrides file.
        </p>
        <p>
          Every transition is recorded in an append-only ledger (<Code>ledger.jsonl</Code>), and
          the current position (file read offsets, last tick, content hashes) lives in{' '}
          <Code>checkpoint.json</Code>. This is what the dashboard's Director card and ledger
          table read. The Director also supervises infrastructure: it restarts an orphaned
          campaign worker, self-heals the local Kafka broker, and rotates a Proton VPN IP on a
          schedule.
        </p>
      </Section>

      <Section id="loops" title="Orchestration loops">
        <p>
          The orchestration is interval-driven, not event-stream driven:{' '}
          <Code>src/orchestrator.ts</Code> starts a <Code>setInterval</Code> tick (default one
          minute) that invokes <Code>DirectorLoop.runOnce()</Code>. A single-flight guard (an
          in-flight <Code>AbortController</Code>) skips a tick if the previous run is still
          running, so slow ticks cannot pile up.
        </p>
        <p>
          Smaller loops follow the same discipline: the Slack poller runs on its own 30-second
          interval with a busy-flag reentrancy guard; the LLM agent loop caps itself at 10 tool
          steps and sleeps with exponential backoff after upstream failures; the provider chain
          retries transient statuses (408/425/5xx) in place with jittered exponential backoff
          before demoting a key or walking to the next provider. Every outbound call carries an{' '}
          <Code>AbortController</Code> timeout, so a hung upstream cannot hold the process
          forever.
        </p>
      </Section>

      <Section id="queues" title="Queues">
        <p>
          There is no heavyweight message broker in the request path. Three small structures
          cover the actual need:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <Code>RotationQueue</Code> (<Code>src/providers/rotation.ts</Code>): an in-memory
            demote-to-back queue used for the OpenRouter key pool and provider chain. A failed key
            is not deleted, just moved to the back, so it naturally comes back once the pool is
            exhausted.
          </li>
          <li>
            <strong>Slack outbox</strong> (<Code>ledger.jsonl</Code>.slack-outbox.json): a durable,
            file-backed retry queue for failed Slack posts. Writes are atomic (temp file +
            rename), and a poison guard caps attempts at 10.
          </li>
          <li>
            <strong>Idempotency cache</strong> (<Code>src/gateway/idempotency.ts</Code>): an
            in-memory Map with a 60s TTL, a 1000-entry cap, and in-flight promise deduplication
            for retried POSTs that carry an <Code>Idempotency-Key</Code>.
          </li>
        </ul>
      </Section>

      <Section id="kafka" title="Kafka outbound queue">
        <p>
          Kafka is used strictly as an outbound observability stream, never as a work queue.
          Director events (observation, proposed, decided, applied) are published as JSON to the{' '}
          <Code>director-events</Code> topic on a local single-node KRaft broker on port 19092.
        </p>
        <p>
          Two deliberate choices: first, msrouter shells out to{' '}
          <Code>kafka-console-producer.sh</Code> (a short-lived JVM per message) instead of taking
          a Kafka client dependency, which is honest about the low event volume; second, nothing
          consumes the topic. Lag is expected and benign, publishing is best-effort and never
          throws into the Director loop, and the broker is not in the Slack approval path. The
          broker status you see on the dashboard is a plain TCP connect probe to the bootstrap
          port.
        </p>
      </Section>

      <Section id="slack" title="Slack integration">
        <p>
          Slack is the human approval gate for the Director. Outbound, a{' '}
          <Code>SlackSurface</Code> posts proposals and decisions via the Slack Web API{' '}
          <Code>chat.postMessage</Code> (bot token + channel, webhook fallback), with the file
          outbox described above absorbing Slack outages. Inbound, a poller reads{' '}
          <Code>conversations.history</Code> every 30 seconds and parses{' '}
          {'"approve <patch-id>"'} / {'"reject <patch-id>"'} replies into decisions that the next
          Director tick consumes. Plain request polling was chosen over Socket Mode or webhooks:
          no extra inbound surface, no extra daemon, and the 30s latency is acceptable for
          approval workflows.
        </p>
      </Section>

      <Section id="rag" title="RAG">
        <p>
          Retrieval-augmented generation lives in a separate Python project, which msrouter
          invokes as a subprocess. The indexer (<Code>index_builder.py</Code>) embeds campaign
          documents and application records with <strong>model2vec</strong>{' '}
          <Code>potion-base-8M</Code> static embeddings and stores the vectors in a SQLite{' '}
          <Code>index.db</Code>. Queries go through <Code>rag_server.py</Code> in one-shot CLI
          mode: Node's <Code>execFile</Code> spawns it with a 30-second timeout and reads JSON
          from stdout; cosine similarity runs in numpy at query time. No external vector DB, no
          embedding API, no long-running Python process.
        </p>
        <p>
          The Node side deliberately owns no embedding logic: the Python venv is the port/adapter
          boundary, and the Director simply rebuilds the index whenever it observes new
          submissions.
        </p>
      </Section>

      <Section id="node" title="Node.js concurrency and the event loop">
        <p>
          Node.js runs your JavaScript on a single thread, yet msrouter handles concurrent HTTP
          requests, spawns subprocesses, and polls several endpoints at once. The gap is bridged
          by the <strong>event loop</strong> plus <strong>libuv</strong>'s thread pool, and it is
          worth spelling out the moving parts:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <strong>Non-blocking I/O is the real multithreading.</strong> Sockets are handed to
            the OS (epoll on Linux, kqueue on macOS); the event loop asks "which fds are ready?"
            and runs the callbacks for exactly those. One thread, thousands of concurrent
            connections, because waiting is free - only callbacks cost time.
          </li>
          <li>
            <strong>Macro tasks vs micro tasks.</strong> The loop processes one macrotask at a
            time: timers (<Code>setTimeout</Code>/<Code>setInterval</Code>), pending I/O
            callbacks, and <Code>setImmediate</Code> checks, in phases. After{' '}
            <em>every</em> macrotask, the loop drains the microtask queue:{' '}
            <Code>Promise</Code> reactions, <Code>queueMicrotask</Code>, and Node's{' '}
            <Code>process.nextTick</Code> (which runs even before other microtasks). That is why
            an <Code>await</Code> in a handler always resumes before the next timer fires, and
            why a runaway recursive microtask chain can starve timers and I/O alike.
          </li>
          <li>
            <strong>The libuv thread pool.</strong> Filesystem calls, <Code>dns.lookup</Code>,
            zlib, and crypto work like scrypt/pbkdf2 are dispatched to a small pool of worker
            threads (default 4, tuned via <Code>UV_THREADPOOL_SIZE</Code>) so the JS thread never
            blocks on slow syscalls. The admin API's password hashing (<Code>crypto.scrypt</Code>
            , N=16384) runs exactly there: handlers stay async while the KDF burns CPU on a pool
            thread.
          </li>
          <li>
            <strong>worker_threads</strong> exist for genuine CPU-bound JavaScript (parsing,
            compression, image work) with structured-clone messaging and{' '}
            <code className="rounded bg-slate-800 px-1 font-mono text-[0.85em] text-cyan-300">
              SharedArrayBuffer
            </code>{' '}
            for zero-copy sharing. msrouter needs none: its only CPU-shaped work (SQL over the
            users array, hashing) is either tiny or already on the libuv pool, and heavy external
            work (Kafka CLI, Python RAG, campaign runs) is isolated in{' '}
            <Code>child_process</Code> subprocesses instead, which also caps blast radius and
            gives each tool its own timeout.
          </li>
        </ul>
        <p>
          The practical rules msrouter follows: never block the loop with sync calls on the hot
          path (<Code>readFileSync</Code>, <Code>*Sync</Code> crypto), give every outbound I/O an{' '}
          <Code>AbortController</Code> timeout, guard interval-driven work against reentrancy,
          and move anything CPU-heavy to a pool thread or a subprocess.
        </p>
      </Section>

      <Section id="data" title="The tiny data layer">
        <p>
          msrouter is deliberately database-free, and this console follows the same philosophy.
          Everything persists in flat files, each with a job it is actually good at:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <strong>JSON files for state</strong>: <Code>data/users.json</Code> (this console's
            users and column defs), <Code>checkpoint.json</Code> (Director position), the Slack
            outbox, and the Director's overrides file. Small, human-inspectable, versioned by
            schema (<Code>schemaVersion</Code>), and written atomically as temp-file + rename so a
            crash never leaves a half-written document.
          </li>
          <li>
            <strong>JSONL for append-only logs</strong>: <Code>ledger.jsonl</Code> gets one JSON
            object per line, appended with <Code>O_APPEND</Code> + fsync. Append-only means no
            read-modify-write races and a complete audit trail; the ledger table on the dashboard
            is just the last 20 lines.
          </li>
          <li>
            <strong>SQLite where relational actually helps</strong>: the RAG index (
            <Code>index.db</Code>) stores thousands of embedding vectors that get scanned by
            cosine similarity - a job for real queries, owned by the Python side.
          </li>
          <li>
            <strong>In-memory only</strong>: the gateway's idempotency cache and this console's
            rate limiter. Ephemeral by design; losing them costs nothing.
          </li>
        </ul>
        <p>
          The users file is the largest structure here (two tables in one document: column defs
          and rows), validated end-to-end by a zod schema shared between server and client. The
          moment multi-user writes, concurrent access, or queryable history mattered, the right
          move would be SQLite - the layer is isolated behind <Code>UserStore</Code> precisely so
          that swap stays cheap.
        </p>
      </Section>

      <Section id="console" title="This web console">
        <p>
          The console is a React 18 + Vite + TypeScript SPA (Tailwind for styling,
          react-router for the login/dashboard/profile/about pages) served by a small admin API
          on port 8790. The API reuses the gateway's own framework-free <Code>node:http</Code>{' '}
          patterns (typed router, correlation ids, zod validation, domain errors) but runs as a
          separate process, reading the ledger and checkpoint read-only: it can observe routing
          and never influence it.
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <strong>Auth</strong>: passwords are hashed with scrypt (N=16384, per-user salt,
            constant-time compare); login issues a JWT signed HS256 - symmetric signing, as this
            is a single self-contained service. Known trade-offs of the stateless design: tokens
            stay valid until expiry (a password change does not revoke outstanding ones), and the
            token lives in localStorage (XSS-exfiltrable; the served CSP restricts scripts to
            self-origin as mitigation). A production split across services would move to RS256
            with short-lived access tokens, rotating refresh tokens, and a per-user token
            version claim for revocation.
          </li>
          <li>
            <strong>Roles</strong>: <Code>admin</Code> can run the SQL console, add columns, and
              create users; <Code>viewer</Code> gets read-only dashboards. Every mutating route
            checks the role server-side (403 for viewers).
          </li>
          <li>
            <strong>Quasi-SQL</strong>: the console runs your SQL over the users array with
            AlaSQL. The statement is parser-verified (AST, not regex) to be a single SELECT with
            the bound parameter as its only source - no INTO sinks, no file reads, no multi
            statements - and rows are sanitized before they reach the engine, so not even{' '}
            <Code>SELECT *</Code> can surface password hashes.
          </li>
          <li>
            <strong>One schema</strong>: <Code>src/shared/schema.ts</Code> defines every request,
            response, and persisted shape once in zod; the server validates with it at runtime,
            the client validates responses with the same objects, and TypeScript's types are
            inferred from it. There is exactly one place where a type can change.
          </li>
          <li>
            <strong>Testing</strong>: the backend is test-driven with co-located vitest specs
            (including real-server integration tests and role-isolation cases), and the frontend
            is tested with vitest + Testing Library at meaningful seams (fake fetch for the API
            client, fake timers for polling). Coverage gates run in CI for both packages.
          </li>
        </ul>
      </Section>

      <Section id="micro" title="Microservice architecture">
        <p>
          msrouter is microservice-shaped without being a distributed system: clean module
          boundaries (<Code>gateway</Code>, <Code>providers</Code>, <Code>director</Code>,{' '}
          <Code>admin</Code>, <Code>shared</Code>), health endpoints (
          <Code>/health/live</Code>, <Code>/health/ready</Code>), supervised external processes
          with probes (Kafka, Chrome CDP, the campaign worker), and configuration injected as
          validated environment. The gateway, Director, and Slack poller run in one process on
          purpose: they share small, file-backed state, and a single process is the simplest thing
          that survives a machine reboot (ADR 0004 records the earlier two-process split and why
          it collapsed back).
        </p>
        <p>
          The seams that would make a split cheap are already in place: the Director is a pure
          tick loop (it could be a worker with the ledger as its queue), Kafka already carries
          outbound events for anyone who wants them, and this admin console is already a separate
          process talking to the gateway only over HTTP. The trade is documented rather than
          hidden: one process today, network hops only where they buy something.
        </p>
      </Section>

      <Section id="opensource" title="Open source">
        <p>
          msrouter is an open-source project, MIT-licensed, developed in the open on{' '}
          <a
            href={REPO_URL}
            className="text-cyan-400 underline decoration-cyan-800 hover:text-cyan-300"
          >
            github.com/mstaszew-dev/msrouter
          </a>
          . The repo practices what a reviewer would check: conventional commits enforced by
          husky + commitlint, a CI pipeline (eslint, typecheck, vitest with coverage gates, bats
          shell tests) on every push and PR, prettier and an editorconfig for formatting, and
          four architecture decision records in <Code>docs/adr/</Code> documenting the
          load-bearing choices. This web console, including its tests and this page, is part of
          that repository.
        </p>
      </Section>
    </div>
  );
}
