from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

STAGE1_PROFILE_CONTRACT: dict[str, object] = {
    "fastembed_version": "0.8.0",
    "dense_model": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    "dense_artifact_repo": "qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q",
    "dense_revision": "faf4aa4225822f3bc6376869cb1164e8e3feedd0",
    "dense_tokenizer": "qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q",
    "dense_tokenizer_revision": "faf4aa4225822f3bc6376869cb1164e8e3feedd0",
    "dense_document_instruction_id": "none",
    "dense_document_instruction": "",
    "dense_query_instruction_id": "none",
    "dense_query_instruction": "",
    "dense_dimensions": 384,
    "dense_normalization": "l2",
    "sparse_model": "Qdrant/bm25",
    "sparse_artifact_repo": "Qdrant/bm25",
    "sparse_revision": "22b8d2af71a76161e18dd432d2cee0eefa66e412",
    "sparse_tokenizer": "fastembed-bm25-tokenization",
    "sparse_tokenizer_revision": "fastembed-0.8.0",
    "sparse_document_instruction_id": "none",
    "sparse_document_instruction": "",
    "sparse_query_instruction_id": "none",
    "sparse_query_instruction": "",
    "sparse_normalization": "none",
}


def _default_env_file() -> Path | None:
    source = Path(__file__).resolve()
    project_root = source.parents[2]
    if (
        source == project_root / "src" / "mycelia_rag" / "config.py"
        and (project_root / "pyproject.toml").is_file()
    ):
        return project_root / ".env"
    # A wheel installation has no stable project .env; use explicit selection
    # or environment variables instead of searching the working directory.
    return None


class Settings(BaseSettings):
    """Runtime configuration; all public names are prefixed with ``RAG_``."""

    model_config = SettingsConfigDict(
        env_prefix="RAG_",
        env_file=None,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def __init__(self, **values: Any) -> None:
        # Explicit constructor settings win. Otherwise select one known file,
        # never a working-directory-dependent dotenv search.
        if "_env_file" not in values:
            if "RAG_ENV_FILE" in os.environ:
                selected = os.environ["RAG_ENV_FILE"]
                if selected and not Path(selected).is_absolute():
                    raise ValueError("RAG_ENV_FILE must be an absolute path or empty")
                values["_env_file"] = selected or None
            else:
                values["_env_file"] = _default_env_file()
        super().__init__(**values)

    mongo_url: str = "mongodb://localhost:27017/?replicaSet=rs0"
    mongo_database: str = "mycelia"
    require_readonly_mongo: bool = False
    mongo_server_selection_timeout_ms: int = Field(default=5_000, ge=100, le=60_000)

    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: SecretStr | None = None
    state_path: Path = Path("./state/rag-state.sqlite3")
    collection_prefix: str = Field(default="mycelia_rag", pattern=r"^[a-zA-Z0-9_-]+$")

    model_cache: Path = Path("./state/models")
    inference_profile: Literal["fastembed-minilm-bm25-v1"] = "fastembed-minilm-bm25-v1"
    fastembed_version: str = Field(default="0.8.0", pattern=r"^\d+\.\d+\.\d+$")
    dense_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    dense_artifact_repo: str = "qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q"
    dense_revision: str = Field(
        default="faf4aa4225822f3bc6376869cb1164e8e3feedd0",
        pattern=r"^[0-9a-f]{40}$",
    )
    dense_tokenizer: str = "qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q"
    dense_tokenizer_revision: str = Field(
        default="faf4aa4225822f3bc6376869cb1164e8e3feedd0",
        pattern=r"^[0-9a-f]{40}$",
    )
    dense_document_instruction_id: str = "none"
    dense_document_instruction: str = ""
    dense_query_instruction_id: str = "none"
    dense_query_instruction: str = ""
    dense_dimensions: int = Field(default=384, ge=8, le=65_536)
    dense_normalization: Literal["l2", "none"] = "l2"

    sparse_model: str = "Qdrant/bm25"
    sparse_artifact_repo: str = "Qdrant/bm25"
    sparse_revision: str = Field(
        default="22b8d2af71a76161e18dd432d2cee0eefa66e412",
        pattern=r"^[0-9a-f]{40}$",
    )
    sparse_tokenizer: str = "fastembed-bm25-tokenization"
    sparse_tokenizer_revision: str = "fastembed-0.8.0"
    sparse_document_instruction_id: str = "none"
    sparse_document_instruction: str = ""
    sparse_query_instruction_id: str = "none"
    sparse_query_instruction: str = ""
    sparse_normalization: Literal["none"] = "none"
    reranker_enabled: bool = False

    auth_mode: Literal["none", "internal_token"] = "none"
    internal_token: SecretStr | None = None

    enable_background: bool = True
    reconcile_interval_seconds: int = Field(default=900, ge=10)
    change_stream_retry_seconds: float = Field(default=5.0, ge=0.1, le=300)
    batch_size: int = Field(default=64, ge=1, le=1_000)
    chunk_size: int = Field(default=1_200, ge=200, le=20_000)
    chunk_overlap: int = Field(default=160, ge=0, le=5_000)
    qdrant_timeout_seconds: float = Field(default=30.0, ge=1, le=300)

    @model_validator(mode="after")
    def validate_related_settings(self) -> Settings:
        if self.chunk_overlap >= self.chunk_size:
            raise ValueError("RAG_CHUNK_OVERLAP must be smaller than RAG_CHUNK_SIZE")
        if self.auth_mode == "internal_token" and not (
            self.internal_token and self.internal_token.get_secret_value()
        ):
            raise ValueError("RAG_INTERNAL_TOKEN is required for RAG_AUTH_MODE=internal_token")
        if self.reranker_enabled:
            raise ValueError("Stage 1 requires RAG_RERANKER_ENABLED=false")
        for field_name, expected in STAGE1_PROFILE_CONTRACT.items():
            actual = getattr(self, field_name)
            if actual != expected:
                env_name = f"RAG_{field_name.upper()}"
                raise ValueError(
                    f"{env_name} is immutable for {self.inference_profile}; "
                    "add a separately versioned inference profile instead"
                )
        if self.dense_tokenizer.casefold() != self.dense_artifact_repo.casefold():
            raise ValueError("Stage 1 dense tokenizer must come from RAG_DENSE_ARTIFACT_REPO")
        if self.dense_tokenizer_revision != self.dense_revision:
            raise ValueError("RAG_DENSE_TOKENIZER_REVISION must equal RAG_DENSE_REVISION")
        if self.sparse_tokenizer != "fastembed-bm25-tokenization":
            raise ValueError("Stage 1 requires RAG_SPARSE_TOKENIZER=fastembed-bm25-tokenization")
        if self.sparse_tokenizer_revision != f"fastembed-{self.fastembed_version}":
            raise ValueError(
                "RAG_SPARSE_TOKENIZER_REVISION must match the FastEmbed runtime version"
            )
        instructions = (
            (
                "RAG_DENSE_DOCUMENT_INSTRUCTION",
                self.dense_document_instruction_id,
                self.dense_document_instruction,
            ),
            (
                "RAG_DENSE_QUERY_INSTRUCTION",
                self.dense_query_instruction_id,
                self.dense_query_instruction,
            ),
            (
                "RAG_SPARSE_DOCUMENT_INSTRUCTION",
                self.sparse_document_instruction_id,
                self.sparse_document_instruction,
            ),
            (
                "RAG_SPARSE_QUERY_INSTRUCTION",
                self.sparse_query_instruction_id,
                self.sparse_query_instruction,
            ),
        )
        for name, instruction_id, text in instructions:
            if (instruction_id == "none") != (text == ""):
                raise ValueError(f"{name}_ID must be 'none' exactly when {name} is empty")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
