import { getAuth } from "@/modules/auth";

// Better Auth endpoints (sign-in, sign-out, get-session, …). Instantiated lazily so that
// `next build` never needs runtime secrets.
const handler = (request: Request) => getAuth().handler(request);

export const GET = handler;
export const POST = handler;
