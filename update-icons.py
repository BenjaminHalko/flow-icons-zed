#!/usr/bin/env python3
"""
Flow Icons Updater for Zed
Usage: python3 update-icons.py <LICENSE_KEY>
   or: FLOW_ICONS_LICENSE=<key> python3 update-icons.py
"""

import hashlib
import json
import os
import platform
import ssl
import sys
import tarfile
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import brotli

# SSL context for macOS certificate issues
ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

# Configuration
SCRIPT_DIR = Path(__file__).parent.resolve()
ICONS_DIR = SCRIPT_DIR / "icons"
THEME_DIR = SCRIPT_DIR / "icon_themes"
VERSION_FILE = SCRIPT_DIR / ".icon-version"
USER_AGENT = "flow-icons-zed/1.0.0"
API_BASE = "https://legit-i9lq.onrender.com/flow-icons"


# Colors
class Colors:
    RED = "\033[0;31m"
    GREEN = "\033[0;32m"
    YELLOW = "\033[1;33m"
    NC = "\033[0m"  # No Color


def get_machine_id():
    """Generate a consistent machine ID."""
    hostname = platform.node()
    return hashlib.md5(hostname.encode()).hexdigest()


def api_request(url, license_key, machine_id=None):
    """Make an authenticated API request."""
    headers = {
        "Authorization": license_key,
        "User-Agent": USER_AGENT,
    }
    if machine_id:
        headers["Machine-Id"] = machine_id

    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=30, context=ssl_context) as response:
            return response.read(), response.status
    except HTTPError as e:
        return e.read(), e.code
    except URLError as e:
        raise Exception(f"Connection error: {e.reason}")


def get_latest_version(license_key):
    """Fetch the latest version info from the server."""
    url = f"{API_BASE}/version?v=1.0.0"
    data, status = api_request(url, license_key)

    if status != 200:
        raise Exception(f"Server error: {data.decode()}")

    return json.loads(data)


def download_icons(url, license_key, machine_id):
    """Download the icon pack."""
    data, status = api_request(url, license_key, machine_id)

    if status != 200:
        raise Exception(f"Download failed: {data.decode()}")

    return data


def extract_icons(compressed_data, output_dir):
    """Extract brotli-compressed tar archive, skipping macOS ._ files."""
    # Decompress brotli
    decompressed = brotli.decompress(compressed_data)

    # Extract tar, filtering out ._ files
    tar_buffer = BytesIO(decompressed)
    with tarfile.open(fileobj=tar_buffer, mode="r:") as tar:
        for member in tar.getmembers():
            # Skip macOS metadata files
            if "/._" in member.name or member.name.startswith("._"):
                continue
            tar.extract(member, output_dir)


def get_current_version():
    """Get the currently installed version."""
    if VERSION_FILE.exists():
        return VERSION_FILE.read_text().strip()
    return None


def save_version(version):
    """Save the current version."""
    VERSION_FILE.write_text(version)


def count_icons(folder):
    """Count PNG files in a folder (excluding macOS ._ files)."""
    path = ICONS_DIR / folder
    if path.exists():
        return len([f for f in path.glob("*.png") if not f.name.startswith("._")])
    return 0


def build_file_icons(icons_folder, folder_name):
    """Build file_icons dict from PNG files in folder."""
    file_icons = {"default": {"path": f"./icons/{folder_name}/file.png"}}

    for png_file in icons_folder.glob("*.png"):
        # Skip macOS metadata files
        if png_file.name.startswith("._"):
            continue
        icon_id = png_file.stem
        # Skip folder icons for file_icons
        if icon_id.startswith("folder_"):
            continue
        file_icons[icon_id] = {"path": f"./icons/{folder_name}/{icon_id}.png"}

    return file_icons


def build_theme_from_vscode_json(vscode_theme_path, folder_name, icons_folder):
    """Build Zed theme mappings from VSCode theme JSON."""
    if not vscode_theme_path.exists():
        return {}, {}, {}

    with open(vscode_theme_path) as f:
        vscode_theme = json.load(f)

    # Extract file extensions mapping
    file_suffixes = dict(vscode_theme.get("fileExtensions", {}))

    # Extract file names mapping
    file_stems = dict(vscode_theme.get("fileNames", {}))

    # Extract folder names mapping
    folder_names = vscode_theme.get("folderNames", {})
    folder_names_expanded = vscode_theme.get("folderNamesExpanded", {})

    named_directory_icons = {}
    for name, icon_id in folder_names.items():
        expanded_id = folder_names_expanded.get(name, f"{icon_id}_open")
        # Only add if icons exist
        if (icons_folder / f"{icon_id}.png").exists():
            named_directory_icons[name] = {
                "collapsed": f"./icons/{folder_name}/{icon_id}.png",
                "expanded": f"./icons/{folder_name}/{expanded_id}.png",
            }

    return file_suffixes, file_stems, named_directory_icons


def build_flow_icons_json():
    """Build the flow-icons.json theme file."""
    THEME_DIR.mkdir(parents=True, exist_ok=True)

    # Build themes
    themes = []

    for folder_name in ["dark", "dim", "light"]:
        icons_folder = ICONS_DIR / folder_name
        vscode_json = ICONS_DIR / f"{folder_name}.json"

        if not icons_folder.exists():
            continue

        # Get mappings from VSCode JSON in parent folder
        file_suffixes, file_stems, named_dirs = build_theme_from_vscode_json(
            vscode_json, folder_name, icons_folder
        )

        # Zed only supports "light" or "dark" appearances - map "dim" to "dark"
        zed_appearance = "dark" if folder_name in ["dark", "dim"] else "light"

        theme = {
            "name": f"Flow {folder_name.capitalize()}",
            "appearance": zed_appearance,
            "directory_icons": {
                "collapsed": f"./icons/{folder_name}/folder_gray.png",
                "expanded": f"./icons/{folder_name}/folder_gray_open.png",
            },
            "file_icons": build_file_icons(icons_folder, folder_name),
            "file_suffixes": file_suffixes,
            "file_stems": file_stems,
            "named_directory_icons": named_dirs,
        }
        themes.append(theme)

    zed_theme = {
        "$schema": "https://zed.dev/schema/icon_themes/v0.3.0.json",
        "name": "Flow Icons",
        "author": "thang-nm",
        "themes": themes,
    }

    output_path = THEME_DIR / "flow-icons.json"
    with open(output_path, "w") as f:
        json.dump(zed_theme, f, indent=2)

    return output_path


def main():
    # Get license key
    license_key = None
    if len(sys.argv) > 1:
        license_key = sys.argv[1]
    else:
        license_key = os.environ.get("FLOW_ICONS_LICENSE")

    if not license_key:
        print(f"{Colors.RED}Error: License key required{Colors.NC}")
        print()
        print(f"Usage: {sys.argv[0]} <LICENSE_KEY>")
        print(f"   or: FLOW_ICONS_LICENSE=<key> {sys.argv[0]}")
        print()
        print("Example: python3 update-icons.py FLOW-XXXX-XXXX-XXXX-XXXX")
        sys.exit(1)

    machine_id = get_machine_id()

    print(f"{Colors.GREEN}Flow Icons Updater for Zed{Colors.NC}")
    print("=" * 32)
    print()

    # Step 1: Check for updates
    print("Checking for updates... ", end="", flush=True)
    try:
        version_info = get_latest_version(license_key)
        remote_version = version_info["version"]
        download_url = version_info["url"]
        print(f"{Colors.GREEN}OK{Colors.NC}")
        print(f"Remote version: {remote_version}")
    except Exception as e:
        print(f"{Colors.RED}Failed{Colors.NC}")
        print(f"Error: {e}")
        sys.exit(1)

    # Check if update is needed
    current_version = get_current_version()
    if current_version:
        print(f"Local version:  {current_version}")

    print()

    # Step 2: Download icons (only if version differs)
    download_success = False
    if current_version == remote_version:
        print(f"{Colors.GREEN}Already up to date!{Colors.NC}")
    else:
        print("Downloading icons... ", end="", flush=True)
        try:
            compressed_data = download_icons(download_url, license_key, machine_id)
            size_mb = len(compressed_data) / (1024 * 1024)
            print(f"{Colors.GREEN}OK{Colors.NC} ({size_mb:.1f}M)")
            download_success = True
        except Exception as e:
            print(f"{Colors.YELLOW}Skipped{Colors.NC}")
            print(f"  ({e})")
            # Check if we have existing icons to use
            if not (ICONS_DIR / "dark").exists():
                print(
                    f"{Colors.RED}Error: No existing icons found. Download required.{Colors.NC}"
                )
                sys.exit(1)
            print("  Using existing icons...")

    # Step 3: Extract icons (filtered, no ._ files)
    if download_success:
        print("Extracting icons... ", end="", flush=True)
        try:
            ICONS_DIR.mkdir(parents=True, exist_ok=True)
            extract_icons(compressed_data, ICONS_DIR)
            print(f"{Colors.GREEN}OK{Colors.NC}")
        except Exception as e:
            print(f"{Colors.RED}Failed{Colors.NC}")
            print(f"Error: {e}")
            sys.exit(1)

    # Step 4: Build theme JSON
    print("Building theme... ", end="", flush=True)
    try:
        theme_path = build_flow_icons_json()
        print(f"{Colors.GREEN}OK{Colors.NC}")
    except Exception as e:
        print(f"{Colors.RED}Failed{Colors.NC}")
        print(f"Error: {e}")
        sys.exit(1)

    # Save version
    save_version(remote_version)

    # Count icons
    dark_count = count_icons("dark")
    dim_count = count_icons("dim")
    light_count = count_icons("light")

    print()
    print(
        f"{Colors.GREEN}Success!{Colors.NC} Icons updated to version {remote_version}"
    )
    print(f"  Dark theme:  {dark_count} icons")
    print(f"  Dim theme:   {dim_count} icons")
    print(f"  Light theme: {light_count} icons")
    print(f"  Theme file:  {theme_path}")
    print()
    print(f"{Colors.YELLOW}Restart Zed to see the updated icons.{Colors.NC}")


if __name__ == "__main__":
    main()
