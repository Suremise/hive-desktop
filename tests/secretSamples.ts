/**
 * Free text with secrets and sign-ins in it that no field's name announces (#699 round 1): what a prompt, a reply or a
 * command may hold. Each sample's `secrets` must never survive masking; its `kept` must (masking is not hiding all: what
 * comes before a credential's name stays). Since #699 round 4 everything after a credential's name in a string is masked,
 * and since round 5 a quoted name (a JSON key) counts the same, so the quoting, continuation, whitespace and JSON cases
 * below (each one a leak an earlier round let through) are all masked by that one rule. Shared by the redaction tests, the console's
 * text-showing subscriptions and its recordings with text.
 */
export interface SecretSample {
  text: string
  secrets: string[]
  kept?: string[]
}

export const SECRET_SAMPLES: SecretSample[] = [
  { text: 'curl --api-key shortPrivateKey --token shortPrivateToken https://example.com', secrets: ['shortPrivateKey', 'shortPrivateToken'], kept: ['curl'] },
  { text: 'tool --password "very secret phrase" --client-secret=\'two words\' --verbose', secrets: ['very secret phrase', 'secret phrase', 'two words'] },
  { text: 'login with device_code=ABCD-EFGH and user_code: WXYZ-1234', secrets: ['ABCD-EFGH', 'WXYZ-1234'] },
  { text: 'Sign in at https://github.com/login/device and enter ABCD-EFGH', secrets: ['ABCD-EFGH'], kept: ['https://github.com/login/device'] },
  { text: 'To sign in, open https://microsoft.com/devicelogin and enter the code QX7PL29KD to authenticate.', secrets: ['QX7PL29KD'] },
  { text: 'Your one-time code: 4F7K-QP2M9', secrets: ['4F7K-QP2M9'] },
  { text: 'password: very secret phrase', secrets: ['very', 'secret phrase'] },
  { text: 'config {"client_secret": "has spaces in it", "passphrase": "open sesame"}', secrets: ['has spaces in it', 'spaces', 'open sesame'], kept: ['config'] },
  { text: 'curl -u admin:hunter2 https://example.com/api', secrets: ['hunter2'], kept: ['curl'] },
  { text: 'redirected to http://localhost:54545/callback?code=oauthCodeValue123&state=oauthStateValue456', secrets: ['oauthCodeValue123', 'oauthStateValue456'] },
  { text: 'export GITHUB_TOKEN=shorttok && gh auth login --with-token < token.txt', secrets: ['shorttok'] },
  { text: 'key sk-ant-api03-abcdefghijklmnop, Authorization: Bearer abc.def.ghi', secrets: ['sk-ant-api03', 'abc.def.ghi'] },
  { text: 'curl -H "Cookie: sessionid=cookieValue1; csrftoken=cookieValue2" https://example.com', secrets: ['cookieValue1', 'cookieValue2'], kept: ['curl'] },
  { text: 'Set-Cookie: auth=setCookieValue; Path=/; HttpOnly', secrets: ['setCookieValue'] },
  { text: 'open https://login.microsoftonline.com/common/oauth2/deviceauth?otc=QWERTY12 to sign in', secrets: ['QWERTY12'], kept: ['https://login.microsoftonline.com/common/oauth2/deviceauth'] },
  { text: 'download https://acct.blob.core.windows.net/c/f.zip?sv=2020-08-04&sig=abcdEFGH1234%3D', secrets: ['abcdEFGH1234'] },
  // Escaped and embedded quotes, and quotes never closed (#699 round 2).
  { text: String.raw`curl --password "very \"secret\" phrase" --verbose`, secrets: ['very', 'secret', 'phrase'], kept: ['curl'] },
  { text: String.raw`{"password":"very \"secret\" phrase","ok":true}`, secrets: ['very', 'secret', 'phrase'] },
  { text: String.raw`tool --api-key "prefix\"privateSuffix" --api-key prefix2"privateSuffix2"`, secrets: ['prefix', 'privateSuffix', 'privateSuffix2'], kept: ['tool'] },
  { text: String.raw`tool --secret 'it\'s private' --quiet`, secrets: ['private'] },
  { text: 'run --token "never closed secret words', secrets: ['never', 'closed', 'secret words'] },
  { text: String.raw`token=abc\"def rest`, secrets: ['abc', 'def'] },
  // A JSON string inside another (a tool's arguments as text): its quotes escaped once.
  { text: String.raw`{"toolArgs":"{\"command\":\"curl --password \\\"two words\\\" -v\",\"password\":\"escaped secret\"}"}`, secrets: ['two words', 'words', 'escaped secret', 'escaped'], kept: ['toolArgs'] },
  { text: String.raw`{\"Authorization\":\"Basic dXNlcjpwYXNz\",\"Cookie\":\"sid=escapedCookie\"}`, secrets: ['dXNlcjpwYXNz', 'escapedCookie'] },
  // Windows quoting and pieces side by side (#699 round 2).
  { text: 'tool --password "very `"secret`" phrase" --verbose', secrets: ['very', 'secret', 'phrase'], kept: ['tool'] },
  { text: 'tool --password "very ""secret"" phrase" --verbose', secrets: ['very', 'secret', 'phrase'], kept: ['tool'] },
  { text: "tool --password 'it''s secret' --verbose", secrets: ["it''s", 's secret'] },
  { text: 'tool --api-key "prefix"privateSuffix --verbose', secrets: ['prefix', 'privateSuffix'], kept: ['tool'] },
  { text: `tool --api-key pre"fix mid"dleSecret'tail end'Suffix --verbose`, secrets: ['pre', 'fix', 'mid', 'dleSecret', 'tail end', 'Suffix'] },
  { text: 'tool --token unquoted`"escapedTail --verbose', secrets: ['unquoted', 'escapedTail'] },
  { text: 'tool --token=split\\ spaceSecret --verbose', secrets: ['split', 'spaceSecret'] },
  { text: '$env:API_KEY = "ps env secret"; Invoke-RestMethod -Headers @{ Authorization = "Bearer psHeaderToken" }', secrets: ['ps env secret', 'psHeaderToken'], kept: ['$env:API_KEY'] },
  { text: '{"Authorization": "Bearer jsonHeaderToken", "ok": true}', secrets: ['jsonHeaderToken'] },
  { text: 'Cookie: a="quoted cookie value"; b=plainCookie', secrets: ['quoted cookie value', 'plainCookie'] },
  // A quoted value with an option-like word in it, a value starting with a dash, words with no quotes at all.
  { text: 'tool --password "starts -dash inside" --verbose', secrets: ['starts', '-dash inside', 'inside'], kept: ['tool'] },
  { text: 'tool --password -dashFirstSecret --verbose', secrets: ['dashFirstSecret'] },
  { text: 'tool --token several plain secret words /flag', secrets: ['several', 'plain secret words'] },
  { text: 'api_key = unquoted words of a key -next', secrets: ['unquoted', 'words of a key'] },
  // Lines continued (PowerShell's backtick, a shell's backslash, LF or CRLF) and quoted values over several lines
  // (#699 round 3).
  { text: 'curl --api-key `\n  shortPrivateKey https://example.com', secrets: ['shortPrivateKey'], kept: ['curl'] },
  { text: 'curl --api-key \\\r\n  shortPrivateKey2 https://example.com', secrets: ['shortPrivateKey2'], kept: ['curl'] },
  { text: 'tool --token first `\r\n  continuedSecret -v', secrets: ['first', 'continuedSecret'], kept: ['tool'] },
  { text: 'tool --password "firstLine\nsecondSecretLine" --verbose', secrets: ['firstLine', 'secondSecretLine'], kept: ['tool'] },
  { text: 'tool --password "firstLine\r\nsecondCrlfSecret\r\nthirdCrlfSecret" --verbose', secrets: ['firstLine', 'secondCrlfSecret', 'thirdCrlfSecret'] },
  { text: 'tool --password "never closed\nsecret on the next line\nand the next', secrets: ['never closed', 'secret on the next line', 'and the next'] },
  { text: 'password: first part \\\n  continuedPasswordPart', secrets: ['first part', 'continuedPasswordPart'] },
  // Text that starts like a masked value isn't one (#699 round 3).
  { text: 'tool --token "<redacted>"privateSuffix --verbose', secrets: ['privateSuffix'] },
  { text: 'token=<redacted>privateSuffix2', secrets: ['privateSuffix2'] },
  { text: 'tool --token <redacted> privateSuffix3 --verbose', secrets: ['privateSuffix3'] },
  { text: '{"token":"<redacted>privateSuffix4","ok":true}', secrets: ['privateSuffix4'] },
  // A continued line's quoted value with option-like fragments in it (#699 round 3).
  { text: 'tool --password `\n  "starts -dashSecret inside" --verbose', secrets: ['starts', '-dashSecret', 'inside'], kept: ['tool'] },
  { text: 'tool --password \\\r\n  "has /slashSecret in it" --verbose', secrets: ['has', '/slashSecret', 'in it'], kept: ['tool'] },
  { text: 'tool --api-key first `\r\n  "second -dashPart" `\n  \'third /slashPart\' -v', secrets: ['first', 'second', '-dashPart', 'third', '/slashPart'], kept: ['tool'] },
  { text: 'tool --password "line one\n  -dashOnLineTwo /slashOnLineTwo" --verbose', secrets: ['line one', '-dashOnLineTwo', '/slashOnLineTwo'] },
  { text: 'password: `\n  "quoted -dashPassword"', secrets: ['quoted', '-dashPassword'] },
  // Bare password names with dash- or slash-prefixed words in their values, and quoted, escaped or spaced user:password
  // values (#699 round 4).
  { text: 'password: very -secret phrase', secrets: ['very', '-secret', 'phrase'] },
  { text: 'passphrase: first /secret tail', secrets: ['first', '/secret', 'tail'] },
  { text: 'curl -u "name with spaces:privatePassword" --verbose', secrets: ['name with spaces', 'privatePassword'], kept: ['curl'] },
  { text: "curl --user='quoted name:privatePassword2' https://example.com", secrets: ['quoted name', 'privatePassword2'], kept: ['curl'] },
  { text: 'curl -u admin:pw\\ with\\ escapedSpaces https://example.com', secrets: ['pw', 'escapedSpaces'], kept: ['curl'] },
  { text: '{"cmd":"curl -u \\"spaced name:privatePassword3\\" -v"}', secrets: ['spaced name', 'privatePassword3'], kept: ['cmd'] },
  // JSON credentials inside or after an ordinary field's object or list, at any depth, in a list, in malformed or embedded
  // JSON, and keys spelt with spaces or dots (#699 round 4).
  { text: '{"note":"x","password": "unterminated value, "ok": tr', secrets: ['unterminated value', 'tr'], kept: ['note'] },
  { text: "[1, 2, {'secret': 'inListSecret'}, 3]", secrets: ['inListSecret'] },
  { text: '{"config":{"password":"hunter2","ok":true},"other":1}', secrets: ['hunter2'], kept: ['config'] },
  { text: '{"items":[{"api_key":"privateKeyValue"}],"ok":true}', secrets: ['privateKeyValue'], kept: ['items'] },
  { text: '{"first":{"ok":true},"token":"privateTokenValue"}', secrets: ['privateTokenValue'], kept: ['first', 'ok'] },
  { text: '{"a":{"b":[{"c":{"secret":"deepSecretValue"}}]},"after":{"x":[1,2]},"password":"laterPassword"}', secrets: ['deepSecretValue', 'laterPassword'] },
  { text: "{'settings': {'auth': {'user': 'u', 'pass': 'nestedAuthValue'}}, 'name': 'n'}", secrets: ['nestedAuthValue'], kept: ['settings'] },
  { text: 'response: {"data":{"items":[{"id":1},{"access_token":"embeddedAccess"', secrets: ['embeddedAccess'], kept: ['response'] },
  { text: '{"list":[1,2,{"x":"y"}],"api key":"spacedKeyValue","api.key":"dottedKeyValue"}', secrets: ['spacedKeyValue', 'dottedKeyValue'], kept: ['list'] },
  { text: '[{"name":"a","token":"arrayToken1"},{"name":"b","token":"arrayToken2"}]', secrets: ['arrayToken1', 'arrayToken2'], kept: ['name'] },
  // Whitespace other than spaces and tabs (#699 round 3: it hung the scanner, gone since round 4).
  { text: 'tool --token short\u000bverticalTabSecret --verbose', secrets: ['short', 'verticalTabSecret'] },
  { text: 'tool --token short\u000cformFeedSecret\u00a0nbspSecret\u3000ideographicSecret --verbose', secrets: ['formFeedSecret', 'nbspSecret', 'ideographicSecret'] },
  { text: 'tool --token short\u2028lineSeparatorSecret -v', secrets: ['lineSeparatorSecret'] }
]
