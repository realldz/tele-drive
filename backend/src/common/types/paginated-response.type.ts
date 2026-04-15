export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  total: number;
}
