import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const endpoint = import.meta.env.VITE_COGNITO_ENDPOINT || undefined;
const client = new CognitoIdentityProviderClient({
  region: import.meta.env.VITE_AWS_REGION || 'eu-west-1',
  ...(endpoint ? { endpoint } : {}),
  credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' }, // public operations; never signed by the pool
});
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID;

const MESSAGES = {
  NotAuthorizedException: 'Incorrect email or password',
  UserNotFoundException: 'Incorrect email or password',
  InvalidPasswordException: 'Choose a password of at least 8 characters with upper and lower case letters, a number and a symbol',
  PasswordResetRequiredException: 'Your password was reset. Ask an administrator for a temporary password.',
};
const friendly = (e) => new Error(MESSAGES[e.name] || e.message || 'Sign-in failed');

const tokensFrom = (result, previousRefresh = null) => ({
  idToken: result.IdToken,
  refreshToken: result.RefreshToken || previousRefresh,
});

/** @returns {{tokens}|{challenge: 'NEW_PASSWORD_REQUIRED', session: string}} */
export async function signInWithPassword(email, password) {
  try {
    const res = await client.send(new InitiateAuthCommand({
      ClientId: CLIENT_ID,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }));
    if (res.ChallengeName === 'NEW_PASSWORD_REQUIRED') return { challenge: res.ChallengeName, session: res.Session };
    if (res.ChallengeName) throw new Error(`This account needs ${res.ChallengeName}, which this app does not support yet`);
    return { tokens: tokensFrom(res.AuthenticationResult) };
  } catch (e) {
    throw friendly(e);
  }
}

/** First sign-in with a temporary password: the teacher chooses their own. */
export async function completeNewPassword(email, session, newPassword) {
  try {
    const res = await client.send(new RespondToAuthChallengeCommand({
      ClientId: CLIENT_ID,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    }));
    return { tokens: tokensFrom(res.AuthenticationResult) };
  } catch (e) {
    throw friendly(e);
  }
}

export async function refresh(refreshToken) {
  const res = await client.send(new InitiateAuthCommand({
    ClientId: CLIENT_ID,
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  }));
  return tokensFrom(res.AuthenticationResult, refreshToken);
}