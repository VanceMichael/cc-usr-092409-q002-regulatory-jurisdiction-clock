/** 稳定的机器可读错误码，HTTP 响应统一为 { error: { code, message } }。 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const notFound = (code: string, message: string) => new HttpError(404, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
