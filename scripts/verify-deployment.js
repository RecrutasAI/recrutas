#!/usr/bin/env node

const https = require('https');
const http = require('http');

async function checkEndpoint(url, expectedStatus = 200) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      resolve({
        url,
        status: res.statusCode,
        success: res.statusCode === expectedStatus
      });
    });
    
    req.on('error', () => {
      resolve({
        url,
        status: 'ERROR',
        success: false
      });
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({
        url,
        status: 'TIMEOUT',
        success: false
      });
    });
  });
}

async function verifyDeployment(baseUrl) {
  console.log(`🔍 Verifying deployment at: ${baseUrl}`);
  
  const endpoints = [
    { path: '/', name: 'Landing Page' },
    { path: '/api/health', name: 'API Health' },
    { path: '/api/platform/stats', name: 'Platform Stats' }
  ];
  
  const results = [];
  
  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint.path}`;
    console.log(`Testing ${endpoint.name}...`);
    
    const result = await checkEndpoint(url);
    results.push({
      ...result,
      name: endpoint.name
    });
  }
  
  console.log('\n📊 Deployment Verification Results:');
  results.forEach(result => {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${result.name}: ${result.status}`);
  });
  
  const allPassed = results.every(r => r.success);
  
  if (allPassed) {
    console.log('\n🎉 Deployment verification passed!');
    console.log('🚀 Your Recrutas demo is ready for YC application');
  } else {
    console.log('\n⚠️  Some checks failed. Please review deployment configuration.');
  }
  
  return allPassed;
}

// Check if URL provided as argument
const deployUrl = process.argv[2];
if (!deployUrl) {
  console.log('Usage: node scripts/verify-deployment.js <deployment-url>');
  console.log('Example: node scripts/verify-deployment.js https://recrutas-demo.vercel.app');
  process.exit(1);
}

verifyDeployment(deployUrl)
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Verification failed:', error);
    process.exit(1);
  });