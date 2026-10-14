# Deployment Guide

This guide covers deploying Recrutas to various platforms.

## Quick Deploy Options

### Vercel (Recommended)

1. **Connect Repository**
   ```bash
   npm install -g vercel
   vercel
   ```

2. **Environment Variables**
   Set these in your Vercel dashboard:
   ```
   DATABASE_URL=your-postgres-url
   SESSION_SECRET=your-session-secret
   OPENAI_API_KEY=your-openai-key
   ```

3. **Build Settings**
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Install Command: `npm install`

### Railway

1. **Deploy with Railway**
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```

2. **Add Database**
   ```bash
   railway add postgresql
   ```

3. **Set Environment Variables**
   ```bash
   railway variables:set OPENAI_API_KEY=your-key
   railway variables:set SESSION_SECRET=your-secret
   ```

### Docker

1. **Build Image**
   ```bash
   docker build -t recrutas .
   ```

2. **Run Container**
   ```bash
   docker run -p 5000:5000 \
     -e DATABASE_URL=your-db-url \
     -e OPENAI_API_KEY=your-key \
     recrutas
   ```

### Docker Compose

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "5000:5000"
    environment:
      - DATABASE_URL=postgresql://postgres:password@db:5432/recrutas
      - OPENAI_API_KEY=your-key
      - SESSION_SECRET=your-secret
    depends_on:
      - db

  db:
    image: postgres:15
    environment:
      - POSTGRES_DB=recrutas
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?set a strong password}
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

## Environment Configuration

### Required Variables
```bash
DATABASE_URL=postgresql://user:pass@host:port/db
SESSION_SECRET=your-session-secret
OPENAI_API_KEY=sk-your-openai-key
```

### Optional Variables
```bash
SENDGRID_API_KEY=SG.your-sendgrid-key
STRIPE_SECRET_KEY=sk_your-stripe-key
RATE_LIMIT_MAX_REQUESTS=100
JOB_SCRAPER_DELAY=2000
```

## Database Setup

### Neon (Recommended)

1. Create account at [neon.tech](https://neon.tech)
2. Create new project
3. Copy connection string
4. Set `DATABASE_URL` environment variable
5. Run migrations: `npm run db:push`

### Traditional PostgreSQL

1. Install PostgreSQL
2. Create database: `createdb recrutas`
3. Set connection string
4. Run migrations: `npm run db:push`

## SSL and Security

### HTTPS Setup
- Use a reverse proxy (nginx, Cloudflare)
- Enable HTTPS redirects
- Set secure cookie flags in production

### Security Headers
```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

## Performance Optimization

### Database Optimization
- Enable connection pooling
- Set up read replicas for scaling
- Index frequently queried columns
- Monitor query performance

### Caching
- Use Redis for session storage
- Cache job data for faster retrieval
- Implement CDN for static assets

### Monitoring
- Set up application monitoring (DataDog, New Relic)
- Monitor database performance
- Track API response times
- Set up error tracking (Sentry)

## Scaling Considerations

### Horizontal Scaling
- Use load balancers
- Deploy multiple instances
- Share session storage (Redis)
- Database connection pooling

### Vertical Scaling
- Monitor CPU and memory usage
- Optimize database queries
- Use caching strategies
- Compress responses

## Health Checks

Add health check endpoint:
```typescript
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version
  });
});
```

## Backup and Recovery

### Database Backups
- Automated daily backups
- Point-in-time recovery
- Cross-region backup storage
- Regular restore testing

### File Storage
- Backup uploaded resumes
- Backup configuration files
- Version control for code

## Troubleshooting

### Common Issues

1. **Database Connection Errors**
   - Check connection string format
   - Verify network connectivity
   - Check SSL settings

2. **Build Failures**
   - Verify Node.js version (>=18)
   - Clear node_modules and reinstall
   - Check TypeScript compilation

3. **Performance Issues**
   - Monitor database slow queries
   - Check memory usage
   - Optimize API endpoints

### Debug Mode
```bash
DEBUG=* npm run dev
```

### Log Analysis
- Use structured logging
- Monitor error rates
- Track performance metrics

## Production Checklist

- [ ] Environment variables configured
- [ ] Database migrations applied
- [ ] SSL certificate installed
- [ ] Security headers configured
- [ ] Health checks enabled
- [ ] Monitoring setup
- [ ] Backups configured
- [ ] Performance testing completed
- [ ] Error tracking enabled
- [ ] Rate limiting configured