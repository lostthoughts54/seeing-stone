import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toPublicError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return new AppError("INVALID_INPUT", "The request contained invalid data.", 400);
  return new AppError("INTERNAL_ERROR", "Something went wrong. Please try again.");
}
