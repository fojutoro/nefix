# API

The contract. Currently empty — endpoints are added here in the same
commit that adds them to the server.

## Base path

All endpoints live under `/api/v1/`. The base URL is configurable on the
client, so the frontend does not assume it is served from the same origin
as the API.

## Authentication

An httpOnly cookie session. There is no token in JavaScript-readable
storage and no `Authorization` header.

## Errors

An error is the HTTP status plus a JSON body:

```json
{ "error": "human message" }
```

The message is for a person to read. Clients branch on the status, never
on the string.

## Endpoints

| Method | Path      | Auth   | Description                                  |
|--------|-----------|--------|----------------------------------------------|
| GET    | `/health` | public | planned; returns status, version and commit  |
