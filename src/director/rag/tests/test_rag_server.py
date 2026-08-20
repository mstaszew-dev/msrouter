import asyncio
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pytest

import rag_server


class _FakeModel:
    def encode(self, texts):
        return np.array([[1.0, 0.0]], dtype=np.float32)


class _FakeStdin:
    def __init__(self, lines):
        self._lines = list(lines)

    def __iter__(self):
        return iter(self._lines)


class _FakeStdout:
    def __init__(self):
        self.chunks = []

    def write(self, s):
        self.chunks.append(s)

    def flush(self):
        pass


class TestCosineSearch:
    def test_empty_matrix_returns_empty(self):
        matrix = np.array([], dtype=np.float32).reshape(0, 0)
        hits = rag_server.cosine_search(np.zeros(4, dtype=np.float32), matrix, [], "apps", 5)
        assert hits == []

    def test_zero_query_returns_empty(self):
        matrix = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
        rows = [
            {"collection": "apps", "meta": {"id": 1}, "chunk": "a"},
            {"collection": "apps", "meta": {"id": 2}, "chunk": "b"},
        ]
        hits = rag_server.cosine_search(np.zeros(2, dtype=np.float32), matrix, rows, "apps", 5)
        assert hits == []

    def test_top_k_sorted_desc_and_filtered_by_collection(self):
        matrix = np.array(
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.9, 0.1], [0.5, 0.5, 0.0]],
            dtype=np.float32,
        )
        rows = [
            {"collection": "apps", "meta": {"id": 1}, "chunk": "a1"},
            {"collection": "docs", "meta": {"id": 2}, "chunk": "d2"},
            {"collection": "apps", "meta": {"id": 3}, "chunk": "a3"},
            {"collection": "apps", "meta": {"id": 4}, "chunk": "a4"},
        ]
        query = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        hits = rag_server.cosine_search(query, matrix, rows, "apps", 2)
        assert [h["meta"]["id"] for h in hits] == [1, 4]
        assert hits[0]["score"] >= hits[1]["score"]
        assert {h["meta"]["id"] for h in hits} == {1, 4}

    def test_zero_norm_rows_are_handled(self):
        matrix = np.array([[0.0, 0.0], [1.0, 0.0]], dtype=np.float32)
        rows = [
            {"collection": "apps", "meta": {"id": 0}, "chunk": "zero"},
            {"collection": "apps", "meta": {"id": 1}, "chunk": "one"},
        ]
        query = np.array([1.0, 0.0], dtype=np.float32)
        hits = rag_server.cosine_search(query, matrix, rows, "apps", 5)
        assert hits[0]["meta"]["id"] == 1
        assert hits[0]["score"] == 1.0

    def test_masked_out_collection_rows_are_skipped(self):
        matrix = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
        rows = [
            {"collection": "apps", "meta": {"id": 1}, "chunk": "a"},
            {"collection": "docs", "meta": {"id": 2}, "chunk": "d"},
        ]
        query = np.array([1.0, 0.0], dtype=np.float32)
        hits = rag_server.cosine_search(query, matrix, rows, "apps", 5)
        assert [h["meta"]["id"] for h in hits] == [1]

    def test_score_rounded_to_3_decimals(self):
        matrix = np.array([[1.0, 2.8284271]], dtype=np.float32)
        rows = [{"collection": "apps", "meta": {"id": 1}, "chunk": "c"}]
        query = np.array([1.0, 0.0], dtype=np.float32)
        hits = rag_server.cosine_search(query, matrix, rows, "apps", 1)
        assert hits[0]["score"] == 0.333


class TestLoadIndex:
    def test_loads_rows_and_matrix(self, tmp_path):
        db = tmp_path / "index.db"
        conn = sqlite3.connect(db)
        conn.execute(
            "CREATE TABLE chunks (id INTEGER PRIMARY KEY, collection TEXT NOT NULL, "
            "source TEXT NOT NULL, chunk TEXT NOT NULL, meta_json TEXT NOT NULL, "
            "vector_json TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO chunks VALUES (1, 'apps', 'tracker.json', 'chunk-a', ?, ?)",
            (json.dumps({"id": 1}), json.dumps([1.0, 0.0])),
        )
        conn.commit()
        conn.close()

        matrix, rows = rag_server.load_index(db)
        assert rows[0]["collection"] == "apps"
        assert rows[0]["meta"] == {"id": 1}
        assert matrix.shape == (1, 2)

    def test_empty_db(self, tmp_path):
        db = tmp_path / "empty.db"
        conn = sqlite3.connect(db)
        conn.execute(
            "CREATE TABLE chunks (id INTEGER PRIMARY KEY, collection TEXT NOT NULL, "
            "source TEXT NOT NULL, chunk TEXT NOT NULL, meta_json TEXT NOT NULL, "
            "vector_json TEXT NOT NULL)"
        )
        conn.close()

        matrix, rows = rag_server.load_index(db)
        assert rows == []
        assert matrix.size == 0

    def test_uses_explicit_timeout(self, tmp_path, monkeypatch):
        """SHOULD #7: sqlite3.connect must receive an explicit timeout."""
        db = tmp_path / "index.db"
        conn = sqlite3.connect(db)
        conn.execute(
            "CREATE TABLE chunks (id INTEGER PRIMARY KEY, collection TEXT NOT NULL, "
            "source TEXT NOT NULL, chunk TEXT NOT NULL, meta_json TEXT NOT NULL, "
            "vector_json TEXT NOT NULL)"
        )
        conn.commit()
        conn.close()

        import sqlite3 as _sqlite3
        original_connect = _sqlite3.connect
        connect_calls = []

        def tracking_connect(path, **kwargs):
            connect_calls.append(kwargs)
            return original_connect(path, **kwargs)

        monkeypatch.setattr(_sqlite3, "connect", tracking_connect)
        rag_server.load_index(db)
        assert any("timeout" in kw for kw in connect_calls)


class TestFormatters:
    def test_format_apps_no_hits(self):
        assert rag_server._format_apps([]) == "No similar past applications found."

    def test_format_apps_hits(self):
        hits = [
            {
                "score": 0.95,
                "meta": {
                    "roleTitle": "Java Dev",
                    "company": "ACME",
                    "source": "linkedin",
                    "appliedAt": "2026-01-02T10:00:00",
                    "status": "applied",
                },
            }
        ]
        out = rag_server._format_apps(hits)
        assert "Java Dev" in out
        assert "@ ACME" in out
        assert "2026-01-02" in out
        assert "T10:00:00" not in out

    def test_format_docs_no_hits(self):
        assert rag_server._format_docs([]) == "No matching doc chunks found."

    def test_format_docs_truncates_long_chunks(self):
        hits = [{"score": 0.8, "meta": {"file": "PORTALS.md", "header": "Poland"}, "chunk": "x" * 600}]
        out = rag_server._format_docs(hits)
        assert "PORTALS.md" in out
        assert "Poland" in out
        assert "x" * 501 not in out

    def test_hit_to_text_apps(self):
        h = {
            "score": 0.9,
            "meta": {
                "roleTitle": "Dev",
                "company": "ACME",
                "source": "linkedin",
                "appliedAt": "2026-01-01",
                "status": "applied",
            },
        }
        out = rag_server._hit_to_text(h, "apps")
        assert out.startswith("score 0.9: Dev @ ACME")

    def test_hit_to_text_docs(self):
        h = {"score": 0.7, "meta": {"file": "SCHEMA.md", "header": "Events"}, "chunk": "body"}
        out = rag_server._hit_to_text(h, "docs")
        assert "SCHEMA.md" in out
        assert "body" in out


class TestLineProtocol:
    def _run(self, monkeypatch, lines, search_impl=None):
        if search_impl is None:
            search_impl = lambda query, collection, k: []  # noqa: E731
        monkeypatch.setattr(rag_server, "_search", search_impl)
        monkeypatch.setattr(rag_server, "DB", Path("/nonexistent/index.db"))
        monkeypatch.setattr(sys, "stdin", _FakeStdin(lines))
        out = _FakeStdout()
        monkeypatch.setattr(sys, "stdout", out)
        rag_server._line_protocol_main(Path("/nonexistent/index.db"), Path("/campaign"))
        return [json.loads(c) for c in out.chunks if c.strip()]

    def test_valid_search_apps(self, monkeypatch):
        def fake_search(query, collection, k):
            assert collection == "apps"
            assert k == 2
            return [
                {
                    "score": 0.9,
                    "meta": {
                        "roleTitle": "Java Dev",
                        "company": "ACME",
                        "source": "linkedin",
                        "appliedAt": "2026-01-01",
                        "status": "applied",
                    },
                    "chunk": "Java Dev at ACME",
                }
            ]

        responses = self._run(
            monkeypatch,
            ['{"id":1,"tool":"rag_search_apps","args":{"query":"java","k":2}}'],
            fake_search,
        )
        assert len(responses) == 1
        assert responses[0]["id"] == 1
        assert responses[0]["result"][0]["score"] == 0.9
        assert "Java Dev" in responses[0]["result"][0]["text"]

    def test_empty_query_error(self, monkeypatch):
        responses = self._run(
            monkeypatch,
            ['{"id":7,"tool":"rag_search_apps","args":{"query":"  "}}'],
        )
        assert responses[0]["id"] == 7
        assert responses[0]["error"] == "query is required"

    def test_unknown_tool_error(self, monkeypatch):
        responses = self._run(
            monkeypatch,
            ['{"id":8,"tool":"bogus_tool","args":{"query":"x"}}'],
        )
        assert responses[0]["error"] == "unknown tool bogus_tool"

    def test_malformed_json_error(self, monkeypatch):
        responses = self._run(monkeypatch, ["this is not json\n"])
        assert responses[0]["id"] is None
        assert "error" in responses[0]

    def test_blank_lines_are_skipped(self, monkeypatch):
        responses = self._run(monkeypatch, ["\n", "  \n", '{"id":1,"tool":"rag_search_docs","args":{"query":"x"}}'])
        assert len(responses) == 1
        assert responses[0]["id"] == 1

    def test_query_without_tool_key_errors(self, monkeypatch):
        responses = self._run(monkeypatch, ['{"id":9,"args":{"query":"x"}}'])
        assert responses[0]["error"].startswith("unknown tool")


class TestSearch:
    def test_ensure_loaded_raises_when_index_missing(self, monkeypatch, tmp_path):
        monkeypatch.setattr(rag_server, "_model", None)
        monkeypatch.setattr(rag_server, "DB", tmp_path / "missing.db")
        with pytest.raises(RuntimeError, match="index not found"):
            rag_server._ensure_loaded()

    def test_search_uses_model_and_matrix(self, monkeypatch):
        monkeypatch.setattr(rag_server, "_model", _FakeModel())
        monkeypatch.setattr(rag_server, "_matrix", np.array([[1.0, 0.0]], dtype=np.float32))
        monkeypatch.setattr(
            rag_server,
            "_rows",
            [{"collection": "apps", "meta": {"id": 1}, "chunk": "c"}],
        )
        hits = rag_server._search("query", "apps", 1)
        assert hits[0]["meta"]["id"] == 1


class TestListTools:
    def test_exposes_expected_tools(self):
        tools = asyncio.run(rag_server.list_tools())
        names = {t.name for t in tools}
        assert names == {"rag_search_apps", "rag_search_docs"}


class TestCallTool:
    def test_empty_query_rejected(self):
        out = asyncio.run(rag_server.call_tool("rag_search_apps", {"query": "  "}))
        assert "query is required" in out[0].text

    def test_rag_search_apps(self, monkeypatch):
        monkeypatch.setattr(
            rag_server,
            "_search",
            lambda q, c, k: [{"score": 0.9, "meta": {"roleTitle": "Dev", "company": "ACME"}, "chunk": "c"}],
        )
        out = asyncio.run(rag_server.call_tool("rag_search_apps", {"query": "java", "k": 3}))
        assert "Dev" in out[0].text

    def test_rag_search_docs(self, monkeypatch):
        monkeypatch.setattr(
            rag_server,
            "_search",
            lambda q, c, k: [{"score": 0.8, "meta": {"file": "a.md", "header": "H"}, "chunk": "body"}],
        )
        out = asyncio.run(rag_server.call_tool("rag_search_docs", {"query": "poland"}))
        assert "a.md" in out[0].text

    def test_unknown_tool(self):
        out = asyncio.run(rag_server.call_tool("bogus", {"query": "x"}))
        assert "unknown tool" in out[0].text

    def test_exception_surfaced_to_agent(self, monkeypatch):
        def boom(q, c, k):
            raise RuntimeError("embedding failed")

        monkeypatch.setattr(rag_server, "_search", boom)
        out = asyncio.run(rag_server.call_tool("rag_search_apps", {"query": "x"}))
        assert "embedding failed" in out[0].text


class TestMainPreloads:
    def test_ensure_loaded_called_before_server_run(self, monkeypatch):
        """BLOCKER #2: _ensure_loaded must run before the async event loop."""
        loaded = []
        monkeypatch.setattr(rag_server, "_ensure_loaded", lambda: loaded.append(True))

        async def fake_run(read, write, opts):
            # If _ensure_loaded was called before server.run, it's already in the list
            pass

        monkeypatch.setattr(rag_server.server, "run", fake_run)
        # Mock stdio_server to yield fake read/write
        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def fake_stdio():
            yield None, None

        monkeypatch.setattr(rag_server, "stdio_server", fake_stdio)
        import asyncio
        asyncio.run(rag_server.main())
        assert loaded == [True]


class TestLogCall:
    def test_emits_hit_summary(self, monkeypatch):
        recorded = []
        monkeypatch.setattr(rag_server, "_log", lambda msg: recorded.append(msg))
        rag_server._log_call("rag_search_apps", "java\nrole", 3, [{"score": 0.9}], 0.0)
        assert len(recorded) == 1
        assert "rag_search_apps" in recorded[0]
        assert "top_score=0.9" in recorded[0]

    def test_emits_na_top_score_without_hits(self, monkeypatch):
        recorded = []
        monkeypatch.setattr(rag_server, "_log", lambda msg: recorded.append(msg))
        rag_server._log_call("rag_search_docs", "q", 1, [], 0.0)
        assert "top_score=n/a" in recorded[0]


class TestLogSink:
    def test_unwritable_rag_log_falls_back_to_stderr(self, monkeypatch, tmp_path):
        monkeypatch.setenv("RAG_LOG", str(tmp_path))  # a directory -> open fails
        fh, label = rag_server._log_sink()
        assert label == "stderr"
        assert fh is sys.stderr

    def test_no_rag_log_uses_stderr(self, monkeypatch):
        monkeypatch.delenv("RAG_LOG", raising=False)
        fh, label = rag_server._log_sink()
        assert label == "stderr"


class TestLogging:
    def test_log_uses_utc_timestamp(self, tmp_path, monkeypatch):
        log_path = tmp_path / "rag.log"
        monkeypatch.setenv("RAG_LOG", str(log_path))
        monkeypatch.setattr(rag_server, "_SINK_FH", None)
        monkeypatch.setattr(rag_server, "_SINK_LABEL", None)
        rag_server._log("timezone test")
        content = log_path.read_text()
        # UTC timestamps end with '+00:00'; naive local timestamps do not
        assert "+00:00" in content

    def test_log_writes_to_rag_log_file(self, tmp_path, monkeypatch):
        log_path = tmp_path / "rag.log"
        monkeypatch.setenv("RAG_LOG", str(log_path))
        monkeypatch.setattr(rag_server, "_SINK_FH", None)
        monkeypatch.setattr(rag_server, "_SINK_LABEL", None)
        rag_server._log("hello there")
        content = log_path.read_text()
        assert "[rag]" in content
        assert "hello there" in content

    def test_log_falls_back_to_stderr(self, monkeypatch, capsys):
        monkeypatch.delenv("RAG_LOG", raising=False)
        monkeypatch.setattr(rag_server, "_SINK_FH", None)
        monkeypatch.setattr(rag_server, "_SINK_LABEL", None)
        rag_server._log("to stderr")
        assert "to stderr" in capsys.readouterr().err

    def test_log_never_raises(self, monkeypatch):
        monkeypatch.setattr(rag_server, "_log_sink", lambda: (_ for _ in ()).throw(OSError("nope")))
        monkeypatch.setattr(rag_server, "_SINK_FH", None)
        monkeypatch.setattr(rag_server, "_SINK_LABEL", None)
        rag_server._log("swallowed")
