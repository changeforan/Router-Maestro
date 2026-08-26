# Injected shim (container-config layer, NOT a Router-Maestro app-code change).
# Azure Files SMB (CIFS) has no Unix extensions, so os.fchmod/os.chmod raise
# PermissionError(EPERM) on the mounted share. Router-Maestro's
# write_json_owner_only() calls os.fchmod(fd, 0o600), which is fatal at startup.
# The share is private to the storage account (not publicly reachable), so
# owner-only permission bits are moot. We make chmod/fchmod tolerant of EPERM.
import os


def _tolerant(orig):
    def wrapper(*args, **kwargs):
        try:
            return orig(*args, **kwargs)
        except PermissionError:
            return None
    return wrapper


for _name in ("fchmod", "chmod", "lchmod"):
    _orig = getattr(os, _name, None)
    if _orig is not None:
        setattr(os, _name, _tolerant(_orig))
