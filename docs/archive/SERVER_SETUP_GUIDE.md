# Server Setup and Testing Guide

## Problem Solved
The local backend server can now be reliably started and tested. The previous blocker of not being able to start the server in the background with proper logging has been resolved.

## Server Management

### Starting the Server
Use the new `start-server-background.sh` script:

```bash
./start-server-background.sh
```

This script:
- Checks for and kills any existing server on port 5000
- Starts the server in the background
- Logs all output to `logs/server.log`
- Saves the PID to `logs/server.pid`
- Verifies the server is listening on port 5000

### Stopping the Server
Use the existing `stop-server.sh` script:

```bash
./stop-server.sh
```

Or manually:
```bash
kill $(cat logs/server.pid)
```

### Viewing Logs
```bash
# View all logs
tail -f logs/server.log

# View last 20 lines
tail -20 logs/server.log
```

### Checking Server Status
```bash
# Check if server is running
ps aux | grep "tsx standalone-server" | grep -v grep

# Check if port 5000 is listening
ss -tln | grep :5000
# or
netstat -tln | grep :5000

# Test server health
curl http://localhost:5000/api/health
```

## Testing API Endpoints

### Quick Test Script
A helper script `test-api.sh` has been created to easily test authenticated endpoints:

```bash
# Test setting role to candidate (default)
./test-api.sh

# Test with different email
./test-api.sh user@example.com

# Test different endpoint
./test-api.sh <candidate test account> /api/candidate/profile GET

# Test with custom data
./test-api.sh <candidate test account> /api/auth/role POST '{"role":"talent_owner"}'
```

### Manual Testing with curl

1. **Get an auth token:**
   ```bash
   npx tsx server/get-token.ts
   ```
   Copy the token from the output.

2. **Test an endpoint:**
   ```bash
   TOKEN="your-token-here"
   curl -X POST http://localhost:5000/api/auth/role \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"role":"candidate"}'
   ```

## Verified Working Endpoints

✅ **POST /api/auth/role** - Successfully tested
- Requires: Authentication token
- Body: `{"role": "candidate" | "talent_owner"}`
- Response: `{"success": true, "user": {...}}`

✅ **GET /api/health** - Server health check
- No authentication required
- Response: `{"status":"healthy","timestamp":"...","version":"1.0.0"}`

## Current Server Status

The server is currently running:
- **PID**: Check `logs/server.pid`
- **Port**: 5000
- **Logs**: `logs/server.log`
- **Status**: ✅ Running and responding

## Next Steps for Testing

You can now proceed with testing the Candidate User Journey:

1. ✅ **Server is running** - The backend is accessible at `http://localhost:5000`
2. ✅ **Authentication works** - Tokens can be obtained and used
3. ✅ **Role setting works** - Users can set their role via `/api/auth/role`

### Continue Testing:
- Test candidate profile creation
- Test resume upload
- Test job search and application flow
- Test other candidate endpoints listed in the routes

## Troubleshooting

### Server won't start
- Check that `.env` file exists and has `DATABASE_URL` set
- Check logs: `tail -f logs/server.log`
- Check if port 5000 is already in use: `ss -tln | grep :5000`

### Server starts but endpoints don't work
- Verify server is listening: `curl http://localhost:5000/api/health`
- Check authentication token is valid (tokens expire after 1 hour)
- Check server logs for errors: `tail -f logs/server.log`

### Can't get auth token
- Verify email/password in `server/get-token.ts` are correct
- Check that Supabase credentials in `.env` are valid
- Ensure user exists in Supabase
