"""Create the key pair that signs ET Tuning update metadata.

Run it on your own computer (needs: pip install cryptography):
    python new_update_key.py

Put the SECRET line in the repo's UPDATE_ED25519_SEED Actions secret and keep a
copy somewhere safe. Put the PUBLIC KEY bytes in TRUSTED_UPDATE_KEYS in
src/update_metadata.rs. Never commit the secret.
"""
import base64
import os

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

seed = os.urandom(32)
public = (
    ed25519.Ed25519PrivateKey.from_private_bytes(seed)
    .public_key()
    .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
)
print("SECRET (UPDATE_ED25519_SEED):", base64.b64encode(seed).decode())
print("PUBLIC KEY (safe to share):", base64.b64encode(public).decode())
print("PUBLIC KEY bytes:", ", ".join(str(b) for b in public))
