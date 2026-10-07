#!/bin/bash
# Comprehensive test script for Vercel deployment

set -e

DEPLOYMENT_URL="${1:-https://recrutas-5c99uji9q-abas-kabatos-projects.vercel.app}"
EMAIL="${E2E_CANDIDATE_EMAIL:?set E2E_CANDIDATE_EMAIL}"
PASSWORD="${E2E_CANDIDATE_PASSWORD:?set E2E_CANDIDATE_PASSWORD}"

echo "=========================================="
echo "Testing Vercel Deployment: $DEPLOYMENT_URL"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Function to test endpoint
test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    local expected_status="${5:-200}"
    
    echo -n "Testing $name... "
    
    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" "$DEPLOYMENT_URL$endpoint" -H "Authorization: Bearer $TOKEN" 2>&1 || echo "ERROR\n000")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$DEPLOYMENT_URL$endpoint" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            -d "$data" 2>&1 || echo "ERROR\n000")
    fi
    
    http_code=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" = "$expected_status" ] || [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
        echo -e "${GREEN}✓ PASS${NC} (HTTP $http_code)"
        ((TESTS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $http_code)"
        echo "  Response: $body"
        ((TESTS_FAILED++))
        return 1
    fi
}

# Test health endpoint (no auth required)
echo "=== Testing Public Endpoints ==="
test_endpoint "Health Check" "GET" "/api/health" "" "200"
test_endpoint "External Jobs" "GET" "/api/external-jobs" "" "200"
test_endpoint "Platform Stats" "GET" "/api/platform/stats" "" "200"
echo ""

# Get authentication token
echo "=== Getting Authentication Token ==="
echo -n "Signing in... "
TOKEN_RESPONSE=$(curl -s -X POST "https://fgdxsvlamtinkepfodfj.supabase.co/auth/v1/token?grant_type=password" \
    -H "Content-Type: application/json" \
    -H "apikey: $(grep VITE_SUPABASE_ANON_KEY .env | cut -d'=' -f2)" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" 2>&1)

TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('access_token', ''))" 2>/dev/null || echo "")

if [ -z "$TOKEN" ]; then
    echo -e "${RED}✗ FAIL${NC} - Could not get auth token"
    echo "Response: $TOKEN_RESPONSE"
    exit 1
else
    echo -e "${GREEN}✓ PASS${NC}"
    echo "Token: ${TOKEN:0:50}..."
fi
echo ""

# Test Candidate Endpoints
echo "=== Testing Candidate Endpoints ==="
test_endpoint "Get Candidate Profile" "GET" "/api/candidate/profile" ""
test_endpoint "Update Candidate Profile" "POST" "/api/candidate/profile" '{"firstName":"Test","lastName":"User","bio":"Test bio"}'
test_endpoint "Get Candidate Stats" "GET" "/api/candidate/stats" ""
test_endpoint "Get Candidate Applications" "GET" "/api/candidate/applications" ""
test_endpoint "Get Candidate Activity" "GET" "/api/candidate/activity" ""
test_endpoint "Get Job Actions" "GET" "/api/candidate/job-actions" ""
test_endpoint "Get AI Matches" "GET" "/api/ai-matches" ""
echo ""

# Test Talent Owner Endpoints
echo "=== Testing Talent Owner Endpoints ==="
test_endpoint "Get Talent Owner Jobs" "GET" "/api/talent-owner/jobs" ""
test_endpoint "Get Recruiter Stats" "GET" "/api/recruiter/stats" ""
echo ""

# Test Job Management
echo "=== Testing Job Management ==="
test_endpoint "Create Job Posting" "POST" "/api/jobs" '{"title":"Test Job","company":"Test Corp","description":"Test description","skills":["React"],"requirements":["Experience"],"location":"Remote","workType":"remote"}'
echo ""

# Test Application Management
echo "=== Testing Application Management ==="
test_endpoint "Get Applicants for Job" "GET" "/api/jobs/1/applicants" ""
echo ""

# Summary
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"
echo "Total: $((TESTS_PASSED + TESTS_FAILED))"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${YELLOW}Some tests failed.${NC}"
    exit 1
fi
