/**
 * Minimal GraphQL transport.
 *
 * VITE_GRAPHQL_ENDPOINT points at local/server.js today and at the AppSync
 * endpoint after the lift. The Authorization header carries a bearer token in
 * both cases: locally one issued by local/token.js, on AWS the Cognito id
 * token. Nothing else changes.
 */
const ENDPOINT = import.meta.env.VITE_GRAPHQL_ENDPOINT || 'http://localhost:4000/graphql';

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
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new GraphQLError(`Server returned ${res.status}`, 'Transport');
  const body = await res.json();
  if (body.errors?.length) {
    const e = body.errors[0];
    throw new GraphQLError(e.message, e.extensions?.errorType, e.extensions?.field);
  }
  return body.data;
}