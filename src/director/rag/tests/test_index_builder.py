import json
import os
import sqlite3
from pathlib import Path

import numpy as np
import pytest

import index_builder


class FakeModel:
    """Minimal .encode() stand-in for minishlab StaticModel."""

    def __init__(self, dim=3):
        self.dim = dim

    def encode(self, texts):
        rows = min(len(texts), self.dim)
        return np.eye(self.dim, dtype=np.float32)[:rows]


class TestAppText:
    def test_company_and_role_repeated(self):
        a = {"company": "ACME", "roleTitle": "Java Dev"}
        out = index_builder.app_text(a)
        assert "Java Dev at ACME" in out
        assert out.count("Java Dev") == 2

    def test_stack_list_upweighted(self):
        a = {"company": "ACME", "roleTitle": "Dev", "stack": ["java", "spring"]}
        out = index_builder.app_text(a)
        assert out.count("java spring") == 2

    def test_scalar_stack_kept_once(self):
        a = {"company": "ACME", "roleTitle": "Dev", "stack": "java"}
        out = index_builder.app_text(a)
        assert out.count("java") == 1

    def test_empty_company_and_role(self):
        out = index_builder.app_text({"source": "linkedin"})
        assert " at " not in out
        assert "linkedin" in out

    def test_salary_currency_once(self):
        a = {"company": "ACME", "roleTitle": "Dev", "salarySeen": {"currency": "PLN", "amount": 15000}}
        out = index_builder.app_text(a)
        assert "PLN" in out


class TestAppMeta:
    def test_extracts_expected_keys(self):
        a = {
            "id": 1,
            "company": "ACME",
            "roleTitle": "Dev",
            "source": "linkedin",
            "appliedAt": "2026-01-01",
            "status": "applied",
        }
        assert index_builder.app_meta(a) == a


class TestChunkDoc:
    def test_splits_by_h2_headers(self):
        text = "intro line\n## Section A\nbody a\n## Section B\nbody b1\nbody b2\n"
        chunks = index_builder.chunk_doc(text)
        assert [t for t, _ in chunks] == ["(intro)", "Section A", "Section B"]

    def test_drops_sections_with_no_body(self):
        text = "## Empty\n## Full\ncontent\n"
        chunks = index_builder.chunk_doc(text)
        assert [t for t, _ in chunks] == ["Full"]

    def test_intro_only(self):
        assert index_builder.chunk_doc("just some text") == [("(intro)", "just some text")]

    def test_empty_text(self):
        assert index_builder.chunk_doc("") == []

    def test_chunk_includes_header_line(self):
        text = "## Title\nbody\n"
        chunks = index_builder.chunk_doc(text)
        assert chunks[0][1].startswith("## Title")


class TestCollectCorpus:
    def test_apps_and_docs(self, tmp_path, capsys):
        (tmp_path / "tracker.json").write_text(
            json.dumps(
                {
                    "applications": [
                        {"company": "ACME", "roleTitle": "Java Dev", "source": "linkedin"},
                        {"id": 2},  # no company/role -> empty text -> skipped
                    ]
                }
            )
        )
        (tmp_path / "PORTALS.md").write_text("## Poland\nhybrid note\n")

        rows = index_builder.collect_corpus(tmp_path)
        apps = [r for r in rows if r["collection"] == "apps"]
        docs = [r for r in rows if r["collection"] == "docs"]
        assert len(apps) == 1
        assert apps[0]["meta"]["company"] == "ACME"
        assert len(docs) == 1
        assert docs[0]["meta"] == {"header": "Poland", "file": "PORTALS.md"}

    def test_missing_doc_reports_to_stderr_and_continues(self, tmp_path, capsys):
        (tmp_path / "tracker.json").write_text(json.dumps({"applications": []}))
        rows = index_builder.collect_corpus(tmp_path)
        assert rows == []
        assert "skip, missing: CONTEXT.md" in capsys.readouterr().err

    def test_missing_tracker_raises(self, tmp_path):
        with pytest.raises(OSError):
            index_builder.collect_corpus(tmp_path)

    def test_malformed_tracker_json_raises_valueerror(self, tmp_path):
        """SHOULD #6: Malformed tracker.json must raise a clear error, not raw traceback."""
        (tmp_path / "tracker.json").write_text("{not valid json")
        with pytest.raises(json.JSONDecodeError):
            index_builder.collect_corpus(tmp_path)

    def test_campaign_path_from_env(self, tmp_path, monkeypatch):
        """SHOULD #9: CAMPAIGN path configurable via RAG_CAMPAIGN env var."""
        (tmp_path / "tracker.json").write_text(json.dumps({"applications": []}))
        monkeypatch.setenv("RAG_CAMPAIGN", str(tmp_path))
        # Re-evaluate the module constant from the env var
        import index_builder as ib
        ib.CAMPAIGN = Path(os.environ.get("RAG_CAMPAIGN", str(ib.CAMPAIGN)))
        rows = ib.collect_corpus(ib.CAMPAIGN)
        assert rows == []


class TestWriteIndex:
    def test_writes_and_recreates_idempotently(self, tmp_path):
        db = tmp_path / "index.db"
        rows = [{"collection": "apps", "source": "t", "chunk": "c", "meta": {"id": 1}}]
        vectors = np.array([[1.0, 0.0, 0.0]], dtype=np.float32)

        index_builder.write_index(rows, vectors, db)
        index_builder.write_index(rows, vectors, db)

        conn = sqlite3.connect(db)
        try:
            count = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            cols = {row[1] for row in conn.execute("PRAGMA table_info(chunks)").fetchall()}
        finally:
            conn.close()
        assert count == 1
        assert cols == {
            "id",
            "collection",
            "source",
            "chunk",
            "meta_json",
            "vector_json",
        }

    def test_stores_vector_json_roundtrip(self, tmp_path):
        db = tmp_path / "index.db"
        rows = [{"collection": "docs", "source": "a.md", "chunk": "c", "meta": {"header": "H"}}]
        vectors = np.array([[0.5, -0.5]], dtype=np.float32)
        index_builder.write_index(rows, vectors, db)
        conn = sqlite3.connect(db)
        try:
            vector = conn.execute("SELECT vector_json FROM chunks").fetchone()[0]
        finally:
            conn.close()
        assert json.loads(vector) == [0.5, -0.5]

    def test_uses_explicit_timeout(self, tmp_path, monkeypatch):
        """SHOULD #7: sqlite3.connect must receive an explicit timeout."""
        db = tmp_path / "index.db"
        rows = [{"collection": "apps", "source": "t", "chunk": "c", "meta": {"id": 1}}]
        vectors = np.array([[1.0, 0.0, 0.0]], dtype=np.float32)

        import sqlite3 as _sqlite3
        original_connect = _sqlite3.connect
        connect_calls = []

        def tracking_connect(path, **kwargs):
            connect_calls.append(kwargs)
            return original_connect(path, **kwargs)

        monkeypatch.setattr(_sqlite3, "connect", tracking_connect)
        index_builder.write_index(rows, vectors, db)
        assert any("timeout" in kw for kw in connect_calls)


class TestBuild:
    def test_check_only_counts_without_writing(self, tmp_path, capsys):
        db = tmp_path / "out.db"
        (tmp_path / "tracker.json").write_text(json.dumps({"applications": []}))
        index_builder.build(check_only=True, model=FakeModel(), campaign=tmp_path, db_path=db)
        assert not db.exists()
        assert "Corpus: 0 applications, 0 doc chunks" in capsys.readouterr().out

    def test_build_writes_index(self, tmp_path):
        db = tmp_path / "out.db"
        (tmp_path / "tracker.json").write_text(
            json.dumps({"applications": [{"company": "ACME", "roleTitle": "Java Dev"}]})
        )
        (tmp_path / "PORTALS.md").write_text("## Poland\nhybrid\n")
        index_builder.build(check_only=False, model=FakeModel(2), campaign=tmp_path, db_path=db)
        assert db.exists()
        conn = sqlite3.connect(db)
        try:
            count = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        finally:
            conn.close()
        assert count == 2  # 1 app + 1 doc
