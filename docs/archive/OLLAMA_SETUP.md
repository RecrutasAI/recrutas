# Ollama Setup Guide - Free Resume Parsing

This guide explains how to use **Ollama** (free, open-source LLM) for resume parsing instead of expensive cloud APIs.

## What is Ollama?

Ollama is a lightweight framework for running large language models locally. It's:
- ✅ **FREE** - No API costs
- ✅ **OPEN SOURCE** - Full transparency
- ✅ **OFFLINE** - Works without internet
- ✅ **PRIVATE** - Your data never leaves your computer
- ⚠️ **SLOWER** - Takes 5-10 seconds per resume (vs 1-2 seconds for cloud APIs)

## Quick Start (5 minutes)

### Option 1: Automated Setup (Recommended)

```bash
# Make script executable
chmod +x setup-ollama.sh

# Run setup
bash setup-ollama.sh
```

This script will:
1. ✅ Start Ollama in Docker
2. ✅ Download Mistral model (~7GB)
3. ✅ Verify everything is working

### Option 2: Manual Setup

```bash
# Start Ollama
docker-compose -f docker-compose.ollama.yml up -d

# Wait 30 seconds, then pull model
docker exec recrutas-ollama ollama pull mistral

# Verify it's working
curl http://localhost:11434
```

### Option 3: Native Ollama Installation

1. Download from: https://ollama.ai
2. Install on your system
3. Run: `ollama pull mistral`
4. Start server: `ollama serve` (if not auto-started)

## Configuration

### Environment Variables

```env
# Use Ollama (default: true)
USE_OLLAMA=true

# Ollama server URL
OLLAMA_URL=http://localhost:11434

# Model to use
OLLAMA_MODEL=mistral
```

### Model Options

| Model | Size | Speed | Quality | Command |
|-------|------|-------|---------|---------|
| **Mistral** | 7GB | ⚡⚡ | ⭐⭐⭐⭐ | `ollama pull mistral` |
| Llama 2 | 4GB | ⚡ | ⭐⭐⭐ | `ollama pull llama2` |
| Neural Chat | 8GB | ⚡⚡ | ⭐⭐⭐⭐ | `ollama pull neural-chat` |
| Zephyr | 4GB | ⚡ | ⭐⭐⭐⭐⭐ | `ollama pull zephyr` |

**Recommended:** Mistral (best balance of speed & quality)

## Testing Resume Upload

Once Ollama is running:

```bash
# 1. Start the Recrutas app
npm run dev

# 2. Open http://localhost:5173
# 3. Go to Upload Resume
# 4. Upload a PDF resume
# 5. Wait 5-10 seconds for local parsing
# 6. See extracted data displayed
```

## Troubleshooting

### Ollama not connecting?

```bash
# Check if container is running
docker ps | grep ollama

# Check logs
docker logs recrutas-ollama

# Manually test
curl http://localhost:11434
```

### Model not pulled?

```bash
# List available models
docker exec recrutas-ollama ollama list

# Pull Mistral manually
docker exec recrutas-ollama ollama pull mistral

# Check disk space (models need 7-10GB)
df -h
```

### App still hanging on resume upload?

1. Check if Ollama is running: `docker ps | grep ollama`
2. Check server logs: `docker logs recrutas-ollama`
3. Try fallback: The app will use rule-based extraction if Ollama fails
4. Disable Ollama: Set `USE_OLLAMA=false` in `.env`

## Performance Tips

### Speed up Parsing

1. **Use faster model:**
   ```bash
   docker exec recrutas-ollama ollama pull zephyr
   # Update .env: OLLAMA_MODEL=zephyr
   ```

2. **Enable GPU (if you have NVIDIA GPU):**
   Edit `docker-compose.ollama.yml` and uncomment the GPU section, then:
   ```bash
   docker-compose -f docker-compose.ollama.yml up -d
   ```

3. **Increase model context:**
   In `.env`, add: `OLLAMA_CONTEXT=2048`

### Monitor Resource Usage

```bash
# Watch Ollama memory usage
docker stats recrutas-ollama
```

## Switching Between Backends

### Use Ollama (Local, Free)
```env
USE_OLLAMA=true
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=mistral
```

### Use OpenAI (Fast, Costs Money)
```env
USE_OLLAMA=false
OPENAI_API_KEY=sk-...
```

### Use Groq (Fast, Free Tier)
```env
USE_OLLAMA=false
GROQ_API_KEY=gsk_...
```

## Production Deployment

For production, consider:

1. **Self-hosted Ollama** on a GPU-enabled server
2. **Hybrid approach:** Ollama for development, cloud API for production
3. **Together.ai** free tier (1M tokens/month)
4. **Small OpenAI plan** ($10/month)

## Costs Comparison (1000 Resumes)

| Solution | Cost | Speed | Setup |
|----------|------|-------|-------|
| Ollama | $0 | 5-10s | Complex |
| Together.ai | FREE (1M tokens) | 2-3s | Simple |
| OpenAI | $2-5 | 1-2s | Simple |
| Groq | FREE (limited) | 1-2s | Simple |

## Additional Resources

- **Ollama Docs:** https://github.com/ollama/ollama
- **Supported Models:** https://ollama.ai/library
- **Together.ai Free Tier:** https://www.together.ai/
- **Running Ollama in Production:** https://github.com/ollama/ollama/blob/main/docs/docker.md

## Next Steps

1. ✅ Run `bash setup-ollama.sh`
2. ✅ Upload a test resume
3. ✅ Verify data extraction works
4. ✅ Commit changes: `git commit -m "feat: Add Ollama integration"`

Happy parsing! 🚀
