// Deleted when the React client lands in phase 3. Not a template for anything:
// no framework, no build step, no styling worth copying, and no error handling.

package http

import "net/http"

func devPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(devHTML))
}

const devHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nefix dev</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  fieldset { margin-bottom: 1rem; }
  label { display: block; margin: .25rem 0; }
  input { width: 100%; box-sizing: border-box; }
  pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>nefix dev page</h1>
<p>Throwaway. Deleted in phase 3.</p>

<fieldset>
  <legend>Register</legend>
  <label>username <input id="r-username" value="jozef"></label>
  <label>display name <input id="r-display" value="Jozef Novák"></label>
  <label>email <input id="r-email" value="jozef@example.sk"></label>
  <label>password <input id="r-password" type="password" value="hunter2hunter2"></label>
  <button onclick="register()">POST /api/v1/register</button>
</fieldset>

<fieldset>
  <legend>Login</legend>
  <label>email <input id="l-email" value="jozef@example.sk"></label>
  <label>password <input id="l-password" type="password" value="hunter2hunter2"></label>
  <button onclick="login()">POST /api/v1/login</button>
</fieldset>

<fieldset>
  <legend>Session</legend>
  <button onclick="me()">GET /api/v1/me</button>
  <button onclick="logout()">POST /api/v1/logout</button>
</fieldset>

<pre id="out">results appear here</pre>

<script>
const out = document.getElementById("out");
const val = id => document.getElementById(id).value;

async function show(label, res) {
  const text = await res.text();
  out.textContent = label + "\n" + res.status + " " + res.statusText + "\n\n" + (text || "(no body)");
}

async function send(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return show("POST " + path, res);
}

const register = () => send("/api/v1/register", {
  username: val("r-username"),
  display_name: val("r-display"),
  email: val("r-email"),
  password: val("r-password"),
});

const login = () => send("/api/v1/login", {
  email: val("l-email"),
  password: val("l-password"),
});

const logout = () => send("/api/v1/logout", null);

const me = async () => show("GET /api/v1/me", await fetch("/api/v1/me"));
</script>
</body>
</html>
`
