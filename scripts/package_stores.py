#!/usr/bin/env python3
"""
Package OmniSense extensions for:
1. Google Chrome Web Store
2. Microsoft Edge Add-ons
3. Mozilla Firefox Add-ons (AMO) - with Gecko / MV3 specific manifest
"""

import os
import zipfile
import json
import shutil

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = "../packages"
os.makedirs(OUT_DIR, exist_ok=True)

# Common folders and files to include
INCLUDE_ITEMS = [
    "background.js",
    "offscreen.html",
    "offscreen.js",
    "assets",
    "brand",
    "content",
    "i18n",
    "npm",
    "onboarding",
    "options",
    "popup",
    "rules",
    "shared",
    "sidepanel",
    "vendor"
]

EXCLUDE_EXTS = {".DS_Store", ".git", ".zip", ".log"}
EXCLUDE_DIRS = {"node_modules", "e2e", "scripts", "_metadata", ".workbuddy", ".git"}

def should_include_file(rel_path):
    parts = rel_path.split(os.sep)
    for p in parts:
        if p in EXCLUDE_DIRS:
            return False
    _, ext = os.path.splitext(rel_path)
    if ext in EXCLUDE_EXTS:
        return False
    return True

def create_zip(target_browser, manifest_dict, zip_name):
    zip_path = os.path.join(OUT_DIR, zip_name)
    if os.path.exists(zip_path):
        os.remove(zip_path)

    total_files = 0
    total_bytes = 0

    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        # Write specific manifest.json
        manifest_str = json.dumps(manifest_dict, indent=2, ensure_ascii=False)
        zf.writestr("manifest.json", manifest_str)
        total_files += 1

        for item in INCLUDE_ITEMS:
            item_path = os.path.join(ROOT_DIR, item)
            if not os.path.exists(item_path):
                continue

            if os.path.isfile(item_path):
                rel = os.path.relpath(item_path, ROOT_DIR)
                if should_include_file(rel):
                    zf.write(item_path, rel)
                    total_files += 1
                    total_bytes += os.path.getsize(item_path)
            elif os.path.isdir(item_path):
                for root, dirs, files in os.walk(item_path):
                    # Filter out excluded directories in-place
                    dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith('.')]
                    for f in files:
                        full_f = os.path.join(root, f)
                        rel = os.path.relpath(full_f, ROOT_DIR)
                        if should_include_file(rel):
                            zf.write(full_f, rel)
                            total_files += 1
                            total_bytes += os.path.getsize(full_f)

    zip_size_mb = os.path.getsize(zip_path) / (1024 * 1024)
    print(f"[{target_browser.upper()}] Created: {zip_path}")
    print(f"  -> {total_files} files, uncompressed: {total_bytes / (1024*1024):.2f} MB, zip size: {zip_size_mb:.2f} MB")
    return zip_path

def main():
    print("=== Packaging OmniSense for 3 Major Browser Stores ===")

    # 1. Base manifest
    with open(os.path.join(ROOT_DIR, "manifest.json"), "r", encoding="utf-8") as f:
        base_manifest = json.load(f)

    # 2. Chrome Web Store Manifest
    chrome_manifest = dict(base_manifest)
    create_zip("Chrome", chrome_manifest, "OmniSense-Chrome-v0.1.0.zip")

    # 3. Microsoft Edge Add-ons Manifest
    edge_manifest = dict(base_manifest)
    create_zip("Edge", edge_manifest, "OmniSense-Edge-v0.1.0.zip")

    # 4. Mozilla Firefox AMO Manifest (Special Firefox MV3 Rules)
    # Differences:
    # - browser_specific_settings.gecko
    # - background.scripts instead of background.service_worker
    # - sidebar_action instead of side_panel
    # - remove unsupported permissions: sidePanel, offscreen, declarativeNetRequestWithHostAccess, declarativeNetRequestFeedback
    firefox_manifest = {
        "manifest_version": 3,
        "name": base_manifest.get("name", "OmniSense"),
        "version": base_manifest.get("version", "0.1.0"),
        "description": base_manifest.get("description", ""),
        "browser_specific_settings": {
            "gecko": {
                "id": "omnisense@local.ai",
                "strict_min_version": "115.0"
            }
        },
        "permissions": [
            "storage",
            "tabs",
            "scripting",
            "activeTab",
            "contextMenus",
            "alarms",
            "declarativeNetRequest"
        ],
        "host_permissions": base_manifest.get("host_permissions", ["<all_urls>"]),
        "background": {
            "scripts": ["background.js"],
            "type": "module"
        },
        "action": base_manifest.get("action", {}),
        "sidebar_action": {
            "default_panel": "sidepanel/sidepanel.html",
            "default_title": "OmniSense",
            "default_icon": "assets/icons/icon-48.png"
        },
        "options_page": base_manifest.get("options_page", "options/options.html"),
        "declarative_net_request": base_manifest.get("declarative_net_request", {}),
        "content_scripts": base_manifest.get("content_scripts", []),
        "web_accessible_resources": base_manifest.get("web_accessible_resources", []),
        "content_security_policy": {
            "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
        },
        "icons": base_manifest.get("icons", {})
    }
    create_zip("Firefox", firefox_manifest, "OmniSense-Firefox-v0.1.0.zip")

    print("\n=== All 3 Packages Successfully Created! ===")

if __name__ == "__main__":
    main()
