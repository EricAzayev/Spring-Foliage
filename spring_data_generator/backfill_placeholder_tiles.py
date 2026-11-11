#!/usr/bin/env python3
"""
Backfill transparent placeholder PNGs for "empty" tiles missing from a tile bucket.

The GPU gridded generator used to skip tiles that contain no foliage data (the
ocean/empty periphery of the raster), so MapLibre requests them at every zoom
level and gets 404s — console noise, and holes that stay unloaded when a tile
re-enters the viewport. Current generators write transparent placeholders
instead; this script fills the gap in an existing bucket without regenerating.

For each day folder in the bucket it derives the tile grid extent from the
tiles that actually exist, then uploads a 256x256 transparent PNG for every
missing (x, y) inside that extent.

Credentials via environment (.env in script dir, repo root, or cwd):
    SUPABASE_URL=https://<project-ref>.supabase.co
    SUPABASE_SERVICE_KEY=<service_role_key>
    SUPABASE_BUCKET=tiles   # optional, defaults to 'tiles'

Usage:
    python spring_data_generator/backfill_placeholder_tiles.py
    python spring_data_generator/backfill_placeholder_tiles.py --dry-run
"""

import argparse
import io
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from PIL import Image

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent
load_dotenv(dotenv_path=_SCRIPT_DIR / ".env")
load_dotenv(dotenv_path=_REPO_ROOT / ".env")
load_dotenv()

SUPABASE_BUCKET = os.environ.get("SUPABASE_BUCKET", "tiles")
_raw_url = os.environ.get("SUPABASE_URL", "")
_parsed = urlparse(_raw_url)
SUPABASE_URL = f"{_parsed.scheme}://{_parsed.netloc}"
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

TILE_SIZE = 256


def make_placeholder_png():
    """One transparent 256x256 PNG, generated once and reused."""
    buf = io.BytesIO()
    Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0)).save(buf, "PNG")
    return buf.getvalue()


def upload(storage_path, png_bytes, content_type="image/png"):
    url = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{storage_path}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "apikey": SUPABASE_SERVICE_KEY,
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    resp = requests.post(url, headers=headers, data=png_bytes, timeout=30)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Upload failed for {storage_path}: HTTP {resp.status_code}: {resp.text[:200]}")


def list_prefix(storage_path, headers):
    """List objects/folders under a storage path (paginated)."""
    url = f"{SUPABASE_URL}/storage/v1/object/list/{SUPABASE_BUCKET}"
    entries, offset = [], 0
    while True:
        resp = requests.post(
            url, headers=headers,
            json={"prefix": storage_path, "limit": 1000, "offset": offset},
            timeout=30,
        )
        if not resp.ok:
            sys.exit(f"Listing '{storage_path}' failed: HTTP {resp.status_code}: {resp.text[:300]}")
        batch = resp.json()
        entries.extend(batch)
        if len(batch) < 1000:
            break
        offset += len(batch)
    return entries


def main():
    parser = argparse.ArgumentParser(description="Backfill placeholder tiles in a Supabase bucket.")
    parser.add_argument("--bucket", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.bucket:
        global SUPABASE_BUCKET
        SUPABASE_BUCKET = args.bucket

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        sys.exit("Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (via .env or environment).")

    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "apikey": SUPABASE_SERVICE_KEY,
    }
    placeholder_bytes = make_placeholder_png()

    print("Tile Placeholder Backfill")
    print("=" * 50)
    print(f"Bucket: '{SUPABASE_BUCKET}'")

    days = sorted(e["name"] for e in list_prefix("", headers) if e.get("name", "").startswith(("day_", "2")))
    print(f"Day folders: {len(days)}")

    total_uploaded = 0
    for day in days:
        placeholders = []
        zs = sorted(e["name"] for e in list_prefix(f"{day}/", headers))
        for z in zs:
            xs = sorted(e["name"] for e in list_prefix(f"{day}/{z}/", headers))
            x_min, x_max = int(xs[0]), int(xs[-1])
            y_min, y_max = None, None
            existing = {}
            for x in xs:
                y_names = [e["name"].removesuffix(".png") for e in list_prefix(f"{day}/{z}/{x}/", headers)]
                ys = {int(n) for n in y_names if n.isdigit()}
                if not ys:
                    continue
                existing[int(x)] = ys
                y_min = int(y_names[0]) if y_min is None else min(y_min, min(ys))
                y_max = int(max(int(n) for n in y_names)) if y_max is None else max(y_max, max(ys))
            if not existing:
                continue
            for x in range(x_min, x_max + 1):
                present = existing.get(x, set())
                missing = set(range(y_min, y_max + 1)) - present
                for y in sorted(missing):
                    placeholders.append((z, x, y))

        if not placeholders:
            print(f"  {day}: complete, nothing to backfill")
            continue

        # Safety guard: before uploading (x-upsert overwrites!), confirm via the
        # public URL that each candidate really is absent. A listing bug must
        # never turn a bucket-wide blind write into silent data loss.
        public_base = f"{SUPABASE_URL}/storage/v1/object/public/{SUPABASE_BUCKET}"
        verified = []
        for z, x, y in placeholders:
            try:
                r = requests.head(f"{public_base}/{day}/{z}/{x}/{y}.png", timeout=15)
            except requests.RequestException:
                continue
            if r.status_code == 404:
                verified.append((z, x, y))
        skipped = len(placeholders) - len(verified)
        if skipped:
            print(f"  {day}: {skipped} candidates unexpectedly exist - skipped, NOT overwritten")

        if args.dry_run:
            print(f"  {day}: {len(verified)} verified missing -> {verified[:6]}{' ...' if len(verified) > 6 else ''}")
            total_uploaded += len(verified)
            continue

        try:
            for z, x, y in verified:
                upload(f"{day}/{z}/{x}/{y}.png", placeholder_bytes)
            print(f"  {day}: uploaded {len(verified)} placeholders")
            total_uploaded += len(verified)
        except RuntimeError as e:
            print(f"  {day}: {e}")

    verb = "Would upload" if args.dry_run else "Uploaded"
    print(f"\n{verb} {total_uploaded:,} placeholder tiles.")


if __name__ == "__main__":
    main()
