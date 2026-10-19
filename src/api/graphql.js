const endpoint = () =>
  import.meta.env?.VITE_GRAPHQL_ENDPOINT ||
  globalThis.CONNECTED_GRAPHQL_ENDPOINT ||
  'http://localhost:4000/graphql';

let tokenProvider = () => null;
export const setTokenProvider = (fn) => {
  tokenProvider = fn;
};

export class GraphQLError extends Error {
  constructor(message, errorType, field) {
    super(message);
    this.errorType = errorType;
    this.field = field;
  }
}

export async function gql(query, variables = {}) {
  const token = await tokenProvider(); // may renew an expired token first (bounded, see AuthContext)
  // A request that never answers would leave a page on "Loading" for ever. Reads give up after
  // 30 seconds; changes (calculating or publishing a whole school) get longer.
  const isChange = /^\s*mutation\b/.test(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), isChange ? 120_000 : 30_000);
  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new GraphQLError('The server took too long to answer. Try again.', 'Timeout');
    // fetch rejects only when the request never got a response.
    throw new GraphQLError('Cannot reach the server', 'Network');
  }

  if (!res.ok) throw new GraphQLError(`Server returned ${res.status}`, 'Transport');
  let body;
  try {
    body = await res.json();
  } catch {
    if (controller.signal.aborted) throw new GraphQLError('The server took too long to answer. Try again.', 'Timeout');
    throw new GraphQLError('The server sent an unreadable answer', 'Transport');
  } finally {
    clearTimeout(timer);
  }
  if (body.errors?.length) {
    const e = body.errors[0];
    throw new GraphQLError(e.message, e.extensions?.errorType, e.extensions?.field);
  }
  return body.data;
}