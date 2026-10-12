#!/usr/bin/env python3
"""
Migrate local snow tiles into the Supabase snow_tiles bucket.

Mirrors the upload pattern from spring_data_generator/generate_tiles_gpu_gridded.py.

Credentials via snow_data_generator/.env (or repo root .env):
    SUPABASE_URL=https://<project-ref>.supabase.co
    SUPABASE_SERVICE_KEY=<service_role_key>
    SUPABASE_BUCKET=snow_tiles   # optional, defaults to snow_tiles

Usage:
    python snow_data_generator/migrate_to_supabase.py
    python snow_data_generator/migrate_to_supabase.py --dry-run
"""

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from tqdm import tqdm

# Match spring script: load .env from script directory first, then repo root
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent
load_dotenv(dotenv_path=_SCRIPT_DIR / ".env")
load_dotenv(dotenv_path=_REPO_ROOT / ".env")
load_dotenv()

# Match spring script config block exactly
SUPABASE_BUCKET = os.environ.get("SUPABASE_BUCKET", "snow_tiles")
_raw_url = os.environ.get("SUPABASE_URL", "")
_parsed = urlparse(_raw_url)
SUPABASE_URL = f"{_parsed.scheme}://{_parsed.netloc}"  # strip any /rest/v1 path suffix
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

DEFAULT_TILES_DIR = _REPO_ROOT / "client" / "public" / "snow_tiles"


def upload_file_to_supabase(storage_path, content, content_type):
    """Upload a file directly via the Supabase Storage REST API."""
    url = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{storage_path}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "apikey": SUPABASE_SERVICE_KEY,
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    resp = requests.post(url, headers=headers, data=content, timeout=30)
    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"Supabase upload failed for {storage_path}: "
            f"HTTP {resp.status_code}: {resp.text}"
        )


def upload_tile(tile_path, tiles_dir):
    """Read a tile from disk and upload it. Mirrors save_tile() in spring script."""
    storage_path = tile_path.relative_to(tiles_dir).as_posix()
    png_bytes = tile_path.read_bytes()
    upload_file_to_supabase(storage_path, png_bytes, "image/png")


def upload_date(date_dir, tiles_dir):
    """Upload all tiles for one date. Mirrors generate_tiles_for_day_gpu()."""
    tiles = sorted(date_dir.rglob("*.png"))
    if not tiles:
        return

    print(f"\n  {date_dir.name} ({len(tiles)} tiles)")

    # Match spring script exactly: ThreadPoolExecutor(max_workers=4),
    # collect futures list, then call .result() on each.
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = []
        for tile_path in tiles:
            futures.append(executor.submit(upload_tile, tile_path, tiles_dir))

        for future in tqdm(futures, desc=f"    {date_dir.name}", leave=False):
            future.result()


def main():
    parser = argparse.ArgumentParser(
        description="Migrate local snow tiles to a Supabase Storage bucket."
    )
    parser.add_argument(
        "--tiles-dir",
        type=Path,
        default=DEFAULT_TILES_DIR,
    )
    parser.add_argument("--bucket", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.bucket:
        global SUPABASE_BUCKET
        SUPABASE_BUCKET = args.bucket

    print("Snow Tile Migration to Supabase")
    print("=" * 50)

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        sys.exit(
            "Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.\n"
            "Add them to snow_data_generator/.env"
        )

    tiles_dir = args.tiles_dir
    if not tiles_dir.exists():
        sys.exit(f"Tiles directory not found: {tiles_dir}")

    manifest_path = tiles_dir / "index.json"
    if not manifest_path.is_file():
        sys.exit(f"Snow tile manifest not found: {manifest_path}")

    date_dirs = sorted(d for d in tiles_dir.iterdir() if d.is_dir() and d.name.isdigit())
    total_tiles = sum(len(list(d.rglob("*.png"))) for d in date_dirs)

    print(f"Supabase upload enabled -> bucket: '{SUPABASE_BUCKET}'")
    print(f"    URL: {SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/")
    print(f"Tiles dir  : {tiles_dir}")
    print(f"Dates      : {len(date_dirs)}")
    print(f"Total tiles: {total_tiles:,}")
    print(f"Manifest   : {manifest_path}")

    if args.dry_run:
        print("\nDRY RUN - no uploads will be performed")
        for d in date_dirs[:5]:
            tiles = list(d.rglob("*.png"))
            if tiles:
                print(f"  {d.name}: {len(tiles)} tiles")
        return

    for date_dir in date_dirs:
        upload_date(date_dir, tiles_dir)

    upload_file_to_supabase(
        "index.json",
        manifest_path.read_bytes(),
        "application/json",
    )
    print("\nDone. Migration complete!")


if __name__ == "__main__":
    main()
