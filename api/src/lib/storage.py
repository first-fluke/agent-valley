from miniopy_async import Minio

from src.lib.config import settings

storage_client = Minio(
    settings.storage_endpoint,
    access_key=settings.storage_access_key,
    secret_key=settings.storage_secret_key,
    secure=settings.storage_secure,
)
