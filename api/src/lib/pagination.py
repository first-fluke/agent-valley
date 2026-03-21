from typing import Any

from pydantic import BaseModel


class PaginationMeta(BaseModel):
    page: int
    size: int
    total: int
    total_pages: int


class PaginatedResponse[T](BaseModel):
    data: list[Any]
    meta: PaginationMeta
    errors: list[Any] | None = None


class SuccessResponse[T](BaseModel):
    data: Any
    meta: dict[str, Any] | None = None
    errors: list[Any] | None = None


def paginate(items: list[Any], total: int, page: int, size: int) -> PaginatedResponse[Any]:
    return PaginatedResponse(
        data=items,
        meta=PaginationMeta(
            page=page,
            size=size,
            total=total,
            total_pages=(total + size - 1) // size if size > 0 else 0,
        ),
    )
