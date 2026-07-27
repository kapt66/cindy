"""
Sign one Windows executable with the existing Meka NPKG signing service.

Usage:
    NPKG_TOKEN=... python sign.py <exe_path>

The token is intentionally read from the environment so it is not exposed in
the process command line.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

try:
    import requests
except ImportError:
    print(
        "[sign.py] Missing Python dependency 'requests'. "
        "Install it in the release environment before signing.",
        file=sys.stderr,
    )
    sys.exit(1)


SERVICE_ORIGIN = "https://npkg.xindong.com"
REQUEST_TIMEOUT_SECONDS = 60
DOWNLOAD_TIMEOUT_SECONDS = 3600


def fail(message):
    print(f"[sign.py] {message}", file=sys.stderr)
    sys.exit(1)


if len(sys.argv) != 2:
    fail("Usage: NPKG_TOKEN=... python sign.py <exe_path>")

exe_path = os.path.abspath(sys.argv[1])
token = os.environ.get("NPKG_TOKEN", "").strip()
if not token:
    fail("NPKG_TOKEN is not set")
if not os.path.isfile(exe_path):
    fail(f"File not found: {exe_path}")

exe_name = os.path.basename(exe_path)
headers = {"Authorization": f"Token {token}"}
tmp_dir = tempfile.mkdtemp(prefix="npkg-sign-")
zip_path = os.path.join(tmp_dir, "sign_target.zip")
signed_zip_path = os.path.join(tmp_dir, "signed.zip")

try:
    print(f"[sign.py] Zipping {exe_name}...")
    def write_archive():
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(exe_path, exe_name)
            # NPKG de-duplicates byte-identical uploads. Shared third-party
            # tools (for example rg.exe) may already have been submitted by
            # another product/token, whose package this token cannot delete.
            # Keep the executable unchanged while making this upload unique.
            archive.comment = f"cindy-meka-sign-{time.time_ns()}-{os.urandom(8).hex()}".encode()

    write_archive()

    def upload(memo):
        with open(zip_path, "rb") as source:
            return requests.post(
                f"{SERVICE_ORIGIN}/api/v1/packages/",
                headers=headers,
                data={"memo": memo},
                files=[("file", (os.path.basename(zip_path), source, "application/octet-stream"))],
                timeout=REQUEST_TIMEOUT_SECONDS,
            )

    print("[sign.py] Uploading...")
    response = upload(f"cindy-meka-sign-{int(time.time())}")
    data = response.json()
    if response.status_code == 409 and data.get("conflict_id"):
        print("[sign.py] Upload conflict; retrying with a unique archive...")
        write_archive()
        response = upload(f"cindy-meka-sign-retry-{int(time.time())}")
        data = response.json()

    if response.status_code not in (200, 201):
        fail(f"Upload failed with HTTP {response.status_code}")

    package_id = data.get("id")
    if not package_id:
        fail("Signing service response has no package id")

    print(f"[sign.py] Waiting for package {package_id}...")
    signed_file_url = None
    for _ in range(30):
        status_response = requests.get(
            f"{SERVICE_ORIGIN}/api/v1/packages/{package_id}/",
            headers=headers,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        status_response.raise_for_status()
        status = status_response.json()
        if status.get("sign_status") == "completed":
            signed_file_url = status.get("sign_file")
            break
        if status.get("sign_status") == "failed":
            fail("Signing failed on the server")
        time.sleep(3)

    if not signed_file_url:
        fail("Signing timed out")
    if not signed_file_url.startswith("/"):
        fail("Signing service returned an invalid download path")

    print("[sign.py] Downloading signed executable...")
    download = requests.get(
        f"{SERVICE_ORIGIN}{signed_file_url}",
        stream=True,
        timeout=DOWNLOAD_TIMEOUT_SECONDS,
    )
    download.raise_for_status()
    with open(signed_zip_path, "wb") as target:
        for chunk in download.iter_content(chunk_size=65536):
            if chunk:
                target.write(chunk)

    extract_dir = os.path.join(tmp_dir, "out")
    os.makedirs(extract_dir)
    with zipfile.ZipFile(signed_zip_path, "r") as archive:
        entries = archive.infolist()
        for entry in entries:
            resolved = os.path.abspath(os.path.join(extract_dir, entry.filename))
            if os.path.commonpath([extract_dir, resolved]) != extract_dir:
                fail("Signed archive contains an unsafe path")
        archive.extractall(extract_dir)

    candidates = []
    for root, _, files in os.walk(extract_dir):
        for file_name in files:
            if file_name.lower().endswith(".exe"):
                candidates.append(os.path.join(root, file_name))
    if len(candidates) != 1:
        fail(f"Expected one signed executable, found {len(candidates)}")

    shutil.copy2(candidates[0], exe_path)
    print(f"[sign.py] Replaced {exe_name}")
except requests.RequestException as error:
    fail(f"Signing service request failed: {error}")
except (ValueError, zipfile.BadZipFile) as error:
    fail(f"Invalid signing service response: {error}")
finally:
    shutil.rmtree(tmp_dir, ignore_errors=True)
