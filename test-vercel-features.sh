#!/bin/bash
# Test all features on Vercel deployment

DEPLOYMENT_URL="${1:-https://recrutas.vercel.app}"
BASE_URL="https://fgdxsvlamtinkepfodfj.supabase.co"

echo "=========================================="
echo "Testing Vercel Deployment Features"
echo "Deployment URL: $DEPLOYMENT_URL"
echo "=========================================="
echo ""

# Test 1: Health Check
echo "1. Testing Health Endpoint..."
HEALTH=$(curl -s "$DEPLOYMENT_URL/api/health" 2>&1)
if echo "$HEALTH" | grep -q "healthy\|status"; then
    echo "   ✓ Health endpoint working"
    echo "$HEALTH" | python3 -m json.tool 2>/dev/null | head -3 || echo "$HEALTH" | head -3
else
    echo "   ✗ Health endpoint not responding correctly"
    echo "   Response: $(echo "$HEALTH" | head -2)"
fi
echo ""

# Test 2: External Jobs (Public)
echo "2. Testing External Jobs Endpoint..."
JOBS=$(curl -s "$DEPLOYMENT_URL/api/external-jobs" 2>&1)
if echo "$JOBS" | grep -q "jobs\|\[\]"; then
    echo "   ✓ External jobs endpoint accessible"
    JOB_COUNT=$(echo "$JOBS" | python3 -c "import sys, json; data=json.load(sys.stdin); print(len(data.get('jobs', [])))" 2>/dev/null || echo "N/A")
    echo "   Jobs found: $JOB_COUNT"
else
    echo "   ✗ External jobs endpoint error"
    echo "   Response: $(echo "$JOBS" | head -2)"
fi
echo ""

# Test 3: Platform Stats (Public)
echo "3. Testing Platform Stats..."
STATS=$(curl -s "$DEPLOYMENT_URL/api/platform/stats" 2>&1)
if echo "$STATS" | grep -q "userCount\|jobCount"; then
    echo "   ✓ Platform stats working"
    echo "$STATS" | python3 -m json.tool 2>/dev/null | head -5 || echo "$STATS" | head -3
else
    echo "   ✗ Platform stats error"
fi
echo ""

# Test 4: Frontend Accessibility
echo "4. Testing Frontend..."
FRONTEND=$(curl -s -I "$DEPLOYMENT_URL" 2>&1 | head -1)
if echo "$FRONTEND" | grep -q "200\|HTTP"; then
    echo "   ✓ Frontend accessible"
    echo "   Status: $(echo "$FRONTEND" | head -1)"
else
    echo "   ✗ Frontend not accessible"
fi
echo ""

# Test 5: Authentication (Supabase)
echo "5. Testing Authentication..."
ANON_KEY=$(grep VITE_SUPABASE_ANON_KEY .env 2>/dev/null | head -1 | cut -d'=' -f2 | tr -d '"' || echo "")
if [ -n "$ANON_KEY" ]; then
    AUTH_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/v1/token?grant_type=password" \
        -H "Content-Type: application/json" \
        -H "apikey: $ANON_KEY" \
        -d "{\"email\":\"${E2E_CANDIDATE_EMAIL:?}\",\"password\":\"${E2E_CANDIDATE_PASSWORD:?}\"}" 2>&1)
    
    if echo "$AUTH_RESPONSE" | grep -q "access_token"; then
        TOKEN=$(echo "$AUTH_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('access_token', ''))" 2>/dev/null || echo "")
        if [ -n "$TOKEN" ]; then
            echo "   ✓ Authentication successful"
            echo "   Token: ${TOKEN:0:50}..."
            
            # Test authenticated endpoint
            echo ""
            echo "6. Testing Authenticated Endpoints..."
            PROFILE=$(curl -s "$DEPLOYMENT_URL/api/candidate/profile" \
                -H "Authorization: Bearer $TOKEN" 2>&1)
            if echo "$PROFILE" | grep -q "userId\|firstName\|email"; then
                echo "   ✓ Candidate profile endpoint working"
            else
                echo "   ✗ Candidate profile endpoint error"
                echo "   Response: $(echo "$PROFILE" | head -2)"
            fi
        else
            echo "   ✗ Could not extract token"
        fi
    else
        echo "   ✗ Authentication failed"
        echo "   Response: $(echo "$AUTH_RESPONSE" | head -3)"
    fi
else
    echo "   ⚠ Could not find Supabase anon key in .env"
fi
echo ""

echo "=========================================="
echo "Testing Complete"
echo "=========================================="
