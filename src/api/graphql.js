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
  const token = tokenProvider();
  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    // fetch rejects only when the request never got a response.
    throw new GraphQLError('Cannot reach the server', 'Network');
  }

  if (!res.ok) throw new GraphQLError(`Server returned ${res.status}`, 'Transport');
  const body = await res.json();
  if (body.errors?.length) {
    const e = body.errors[0];
    throw new GraphQLError(e.message, e.extensions?.errorType, e.extensions?.field);
  }
  return body.data;
}