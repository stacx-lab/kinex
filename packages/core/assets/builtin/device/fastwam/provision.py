"""Download pinned artifacts, verify content, and emit an unloaded profile candidate."""

import argparse
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastwam_config import VARIANTS, make_profile

HERE = Path(__file__).resolve().parent


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


def download(artifact):
    from huggingface_hub import hf_hub_download
    path = HERE / "weights" / artifact["repo"] / artifact["filename"]
    print(f"Provisioning {artifact['repo']}/{artifact['filename']}", flush=True)
    if verify(path, artifact):
        return
    hf_hub_download(artifact["repo"], artifact["filename"], revision=artifact["revision"],
                    local_dir=HERE / "weights" / artifact["repo"], force_download=path.exists())
    if not verify(path, artifact):
        raise ValueError(f"Artifact checksum mismatch: {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--compute", default="cuda:0")
    parser.add_argument("--variant", choices=VARIANTS, default="libero_uncond_2cam224")
    args = parser.parse_args()
    import torch

    torch.zeros(1, device=args.compute)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(download, json.loads((HERE / "artifacts.json").read_text())))
    profile = make_profile(HERE, args.variant, int(args.compute.split(":")[1]))
    (HERE / "profile.generated.json").write_text(json.dumps(profile, indent=2) + "\n")


if __name__ == "__main__":
    main()
