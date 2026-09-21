from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import sys
import zipfile


ALLOWED_DATA_FILES = {Path("examples/synthetic_project.xlsx")}
BLOCKED_DATA_SUFFIXES = {".csv", ".db", ".parquet", ".sqlite", ".xls", ".xlsx"}
SKIP_DIRECTORIES = {".git", ".venv", "__pycache__", "build", "dist"}
SUSPICIOUS_ARCHIVE_PARTS = (
    "connections",
    "customxml/",
    "externallinks/",
    "vbaproject",
)
_WINDOWS_USER_PATH = r"[A-Za-z]:\\" + "Users" + r"\\"
_MAC_USER_PATH = "/" + "Users/"
_LINUX_USER_PATH = "/" + "home/"

SECRET_PATTERNS = {
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "local user path": re.compile(
        rf"(?:{_WINDOWS_USER_PATH}|{_MAC_USER_PATH}|{_LINUX_USER_PATH})[^\s\"']+"
    ),
    "generic credential assignment": re.compile(
        r"(?i)\b(?:api[_-]?key|client[_-]?secret|password|private[_-]?token)\b\s*[:=]\s*['\"][^'\"]{8,}['\"]"
    ),
}


def iter_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in SKIP_DIRECTORIES for part in relative.parts):
            continue
        yield relative, path


def load_denylist(path: Path | None) -> list[str]:
    if path is None:
        return []
    terms = []
    for line in path.read_text(encoding="utf-8").splitlines():
        term = line.strip()
        if term and not term.startswith("#"):
            terms.append(term.casefold())
    return terms


def scan_text(label: str, text: str, denylist: list[str]) -> list[str]:
    findings = []
    for name, pattern in SECRET_PATTERNS.items():
        if pattern.search(text):
            findings.append(f"{label}: matched {name}")
    folded = text.casefold()
    for term in denylist:
        if term in folded:
            digest = hashlib.sha256(term.encode("utf-8")).hexdigest()[:12]
            findings.append(f"{label}: matched private denylist term sha256:{digest}")
    return findings


def scan_xlsx(relative: Path, path: Path, denylist: list[str]) -> list[str]:
    findings = []
    try:
        with zipfile.ZipFile(path) as archive:
            for member in archive.namelist():
                normalized = member.casefold()
                if any(fragment in normalized for fragment in SUSPICIOUS_ARCHIVE_PARTS):
                    findings.append(f"{relative}: contains suspicious workbook part {member}")
                if not normalized.endswith((".xml", ".rels", ".txt")):
                    continue
                content = archive.read(member).decode("utf-8", errors="ignore")
                findings.extend(scan_text(f"{relative}!{member}", content, denylist))
    except zipfile.BadZipFile:
        findings.append(f"{relative}: invalid XLSX archive")
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reject sensitive or unexpected data before public publication.")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--denylist", type=Path)
    args = parser.parse_args(argv)

    root = args.root.resolve()
    denylist = load_denylist(args.denylist)
    findings: list[str] = []
    for relative, path in iter_files(root):
        if path.suffix.casefold() in BLOCKED_DATA_SUFFIXES and relative not in ALLOWED_DATA_FILES:
            findings.append(f"{relative}: data file is not allowed in the public repository")
            continue
        if path.suffix.casefold() == ".xlsx":
            findings.extend(scan_xlsx(relative, path, denylist))
            continue
        if path.stat().st_size > 5_000_000:
            findings.append(f"{relative}: file exceeds the 5 MB public-review limit")
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        findings.extend(scan_text(str(relative), text, denylist))

    if findings:
        print("Public-data check failed:", file=sys.stderr)
        for finding in sorted(set(findings)):
            print(f"- {finding}", file=sys.stderr)
        return 1
    print(f"Public-data check passed ({sum(1 for _ in iter_files(root))} files scanned).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
