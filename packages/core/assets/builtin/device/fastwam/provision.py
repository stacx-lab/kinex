"""Download and verify one FastWAM variant's pinned artifacts; no ML imports."""

import argparse
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path

HERE = Path(__file__).resolve().parent


def selected(variant):
    """The variant's checkpoint and statistics plus the shared Wan backbone files."""
    return [item for item in json.loads((HERE / "artifacts.json").read_text())
            if item["repo"] != "yuanty/fastwam"
            or Path(item["filename"]).stem.removesuffix("_dataset_stats") == variant]


def verify(path, artifact):
    if not path.is_file() or path.stat().st_size != artifact["size"]:
        return False
    digest = hashlib.sha256() if "sha256" in artifact else hashlib.sha1()
    if "git_blob" in artifact:
        digest.update(f"blob {artifact['size']}\0".encode())
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest() == artifact.get("sha256", artifact.get("git_blob"))


def download(directory, artifact):
    from huggingface_hub import hf_hub_download
    path = directory / "weights" / artifact["repo"] / artifact["filename"]
    if verify(path, artifact):
        return
    print(f"Provisioning {artifact['repo']}/{artifact['filename']}", flush=True)
    hf_hub_download(artifact["repo"], artifact["filename"], revision=artifact["revision"],
                    local_dir=directory / "weights" / artifact["repo"], force_download=path.exists())
    if not verify(path, artifact):
        raise ValueError(f"Artifact checksum mismatch: {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("variant")
    args = parser.parse_args()
    artifacts = selected(args.variant)
    if not any(item["repo"] == "yuanty/fastwam" for item in artifacts):
        parser.error(f"unknown variant: {args.variant}")
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(partial(download, args.directory), artifacts))


if __name__ == "__main__":
    main()
