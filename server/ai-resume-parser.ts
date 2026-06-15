import mammoth from 'mammoth';
import { extractText, getDocumentProxy, renderPageAsImage } from 'unpdf';
import Tesseract from 'tesseract.js';
import Groq from 'groq-sdk';
import { parseResumeWithIntelligence } from './skill-intelligence';
import { callAIWithPDF, isAIAvailable } from './lib/ai-client';
import { throttledGroqRequest, type GroqPriority } from './lib/groq-limiter';

// Lazy-initialize Groq client to ensure env vars are loaded (ESM imports hoist before dotenv.config)
let _groq: Groq | null = null;
function getGroqClient(): Groq | null {
  if (_groq === null && process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== '%GROQ_API_KEY%') {
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groq;
}

interface AIExtractedData {
  personalInfo: {
    name?: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
    github?: string;
    portfolio?: string;
  };
  summary: string;
  skills: {
    technical: string[];
    soft: string[];
    tools: string[];
  };
  experience: {
    totalYears: number;
    level: 'entry' | 'mid' | 'senior' | 'executive';
    positions: Array<{
      title: string;
      company: string;
      duration: string;
      responsibilities: string[];
    }>;
  };
  education: Array<{
    degree: string;
    institution: string;
    year?: string;
    gpa?: string;
  }>;
  certifications: string[];
  projects: Array<{
    name: string;
    description: string;
    technologies: string[];
  }>;
  languages: string[];
}

interface ParsedResume {
  text: string;
  aiExtracted: AIExtractedData;
  confidence: number;
  processingTime: number;
}

const RESUME_EXTRACTION_PROMPT = `Extract the following information from this resume and return as JSON:

{
  "personalInfo": { "name": "", "email": "", "phone": "", "location": "", "linkedin": "", "github": "", "portfolio": "" },
  "summary": "",
  "skills": { "technical": [], "soft": [], "tools": [] },
  "experience": { "totalYears": 0, "level": "entry|mid|senior|executive", "positions": [{ "title": "", "company": "", "duration": "", "responsibilities": [] }] },
  "education": [{ "degree": "", "institution": "", "year": "", "gpa": "" }],
  "certifications": [],
  "projects": [{ "name": "", "description": "", "technologies": [] }],
  "languages": []
}`;

export class AIResumeParser {
  private skillsDatabase = [
    // Programming Languages
    'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Go', 'Rust', 'Ruby', 'PHP', 'Swift', 'Kotlin', 'Scala', 'R', 'MATLAB', 'Perl', 'Shell', 'PowerShell',

    // Frontend Technologies
    'React', 'Vue.js', 'Angular', 'Svelte', 'Next.js', 'Nuxt.js', 'Gatsby', 'HTML5', 'CSS3', 'SASS', 'LESS', 'Tailwind CSS', 'Bootstrap', 'Material-UI', 'Ant Design',

    // Backend Technologies
    'Node.js', 'Express.js', 'Django', 'Flask', 'FastAPI', 'Spring Boot', 'ASP.NET', 'Ruby on Rails', 'Laravel', 'Symfony', 'NestJS', 'GraphQL', 'REST API',

    // Databases
    'MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'DynamoDB', 'SQLite', 'Oracle', 'SQL Server', 'Cassandra', 'Neo4j', 'Elasticsearch', 'Firebase', 'Supabase',

    // Cloud & DevOps
    'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Jenkins', 'GitLab CI', 'GitHub Actions', 'Terraform', 'Ansible', 'Chef', 'Puppet', 'Helm', 'ArgoCD',

    // Mobile Development
    'React Native', 'Flutter', 'iOS', 'Android', 'Xamarin', 'Ionic', 'Cordova', 'Swift', 'Objective-C', 'Kotlin', 'Java Android',

    // Data Science & AI
    'TensorFlow', 'PyTorch', 'Pandas', 'NumPy', 'Scikit-learn', 'Keras', 'OpenCV', 'NLTK', 'SpaCy', 'Jupyter', 'Tableau', 'Power BI', 'Apache Spark', 'Hadoop',

    // Design & UX
    'Figma', 'Sketch', 'Adobe XD', 'Photoshop', 'Illustrator', 'InDesign', 'Canva', 'Framer', 'Principle', 'InVision', 'Zeplin',

    // Testing & Quality
    'Jest', 'Cypress', 'Selenium', 'Playwright', 'Postman', 'JMeter', 'SonarQube', 'ESLint', 'Prettier', 'Mocha', 'Chai',

    // Project Management & Collaboration
    'Jira', 'Confluence', 'Trello', 'Asana', 'Monday.com', 'Slack', 'Microsoft Teams', 'Notion', 'Linear', 'GitHub', 'GitLab', 'Bitbucket'
  ];

  private softSkills = [
    'Leadership', 'Communication', 'Problem Solving', 'Team Management', 'Project Management', 'Critical Thinking',
    'Analytical Skills', 'Creativity', 'Adaptability', 'Time Management', 'Collaboration', 'Mentoring',
    'Strategic Planning', 'Decision Making', 'Negotiation', 'Presentation Skills', 'Customer Service'
  ];

  async parseFile(fileContent: Buffer | string, mimeType: string): Promise<ParsedResume> {
    const PARSE_TIMEOUT_MS = 60000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Resume parsing timeout (60s)')), PARSE_TIMEOUT_MS)
    );

    const doParseFile = async (): Promise<ParsedResume> => {
      const startTime = Date.now();

      // Path 1: PDF — try Gemini multimodal FIRST (reads raw bytes, handles all PDF types)
      if (typeof fileContent !== 'string' || fileContent !== 'text-input') {
        if (mimeType === 'application/pdf' && isAIAvailable('pdf')) {
          try {
            console.log('[AIResumeParser] PDF detected — trying multimodal AI (primary)');
            const jsonStr = await callAIWithPDF(
              'You are an expert resume parser. Extract structured data and return ONLY valid JSON.',
              RESUME_EXTRACTION_PROMPT,
              fileContent as Buffer,
              { priority: 'high', maxOutputTokens: 2500 }
            );
            const aiExtracted = this.parseAIResponse(jsonStr);
            const confidence = this.calculateConfidence(aiExtracted);
            const totalSkills = (aiExtracted.skills?.technical?.length || 0) +
              (aiExtracted.skills?.soft?.length || 0) +
              (aiExtracted.skills?.tools?.length || 0);
            console.log(`[AIResumeParser] Gemini multimodal succeeded: ${totalSkills} skills, confidence ${confidence}`);
            // Also try to extract text for storage (best-effort, non-blocking)
            let text = '[extracted via Gemini multimodal]';
            try {
              const extracted = await this.extractText(fileContent as Buffer, mimeType);
              if (extracted && extracted.trim().length >= 50) text = extracted;
            } catch { /* text extraction is optional here */ }
            return { text, aiExtracted, confidence, processingTime: Date.now() - startTime };
          } catch (geminiErr) {
            console.warn('[AIResumeParser] Gemini multimodal failed, falling back to text extraction:', (geminiErr as Error).message);
          }
        }

        // Path 2: text extraction → AI (fallback for PDFs, primary for DOCX/TXT)
        let text = '';
        try {
          text = await this.extractText(fileContent as Buffer, mimeType);
          console.log(`[AIResumeParser] Extracted ${text.length} characters from ${mimeType}`);
        } catch (extractErr) {
          console.warn('[AIResumeParser] Text extraction failed, trying rules anyway:', (extractErr as Error).message);
          text = ''; // Will use rules on empty text
        }
        const aiExtracted = await this.extractWithAI(text || ' ');
        const confidence = this.calculateConfidence(aiExtracted);
        return { text: text || '[no text extracted - using rule-based parsing]', aiExtracted, confidence, processingTime: Date.now() - startTime };
      }

      // Sample/demo path
      try {
        const text = this.getSampleResumeText();
        const aiExtracted = await this.extractWithAI(text);
        const confidence = this.calculateConfidence(aiExtracted);
        return { text, aiExtracted, confidence, processingTime: Date.now() - startTime };
      } catch (error) {
        console.error('AI Resume parsing error:', error);
        throw new Error(`Failed to parse resume with AI: ${(error as Error).message}`);
      }
    };

    return Promise.race([doParseFile(), timeoutPromise]);
  }

  async parseText(resumeText: string): Promise<ParsedResume> {
    const startTime = Date.now();

    try {
      // Use AI-powered extraction on provided text
      const aiExtracted = await this.extractWithAI(resumeText);

      // Calculate confidence based on extracted data completeness
      const confidence = this.calculateConfidence(aiExtracted);

      const processingTime = Date.now() - startTime;

      return {
        text: resumeText,
        aiExtracted,
        confidence,
        processingTime
      };
    } catch (error) {
      console.error('AI Resume parsing error:', error);
      throw new Error('Failed to parse resume text with AI');
    }
  }

  private parseAIResponse(jsonStr: string): AIExtractedData {
    try {
      return JSON.parse(jsonStr) as AIExtractedData;
    } catch {
      // Try stripping markdown code fences
      const stripped = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
      return JSON.parse(stripped) as AIExtractedData;
    }
  }

  private async extractText(fileBuffer: Buffer, mimeType: string): Promise<string> {
    if (mimeType === 'application/pdf') {
      // Try text extraction first (works for text-based PDFs)
      try {
        const pdf = await getDocumentProxy(new Uint8Array(fileBuffer));
        const { text } = await extractText(pdf, { mergePages: true });
        if (text && text.trim().length >= 50) {
          return text;
        }
        console.log('[AIResumeParser] PDF text extraction returned thin content, may be scanned');
      } catch (textErr) {
        console.warn('[AIResumeParser] PDF text extraction failed:', (textErr as Error).message);
      }

      // OCR fallback for scanned PDFs using Tesseract.js (open-source, free)
      try {
        console.log('[AIResumeParser] Trying OCR with Tesseract.js (rendering pages to images)...');
        
        const pdf = await getDocumentProxy(new Uint8Array(fileBuffer));
        const { totalPages } = await extractText(pdf, { mergePages: false });
        
        let fullText = '';
        const maxPages = Math.min(totalPages, 3); // Limit to 3 pages for speed
        
        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
          try {
            // Render page to image using unpdf with canvas support
            const imageBuffer = await renderPageAsImage(pdf, pageNum, { 
              scale: 1.5,
              canvasImport: async () => (await import('@napi-rs/canvas')).default,
            });
            
            // Run OCR on the image
            const result = await Tesseract.recognize(Buffer.from(imageBuffer), 'eng', {
              logger: () => {},
            });
            
            if (result.data.text) {
              fullText += result.data.text + '\n';
            }
            console.log(`[AIResumeParser] OCR page ${pageNum}/${maxPages}: ${result.data.text?.slice(0, 50)}...`);
          } catch (pageErr) {
            console.warn(`[AIResumeParser] OCR failed for page ${pageNum}:`, (pageErr as Error).message);
          }
        }
        
        if (fullText.trim().length >= 20) {
          console.log('[AIResumeParser] OCR extracted text, using for parsing:', fullText.slice(0, 100));
          return fullText;
        }
        console.log('[AIResumeParser] OCR returned thin content, continuing to AI parsing');
      } catch (ocrErr) {
        console.warn('[AIResumeParser] OCR failed:', (ocrErr as Error).message);
      }

      // Return empty string - let AI parsing handle it with rules
      console.log('[AIResumeParser] All text extraction methods failed, passing to AI rules');
      return '';
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mimeType === 'application/msword') {
      try {
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        if (!result.value || result.value.trim().length < 50) {
          throw new Error('Word document extracted text is empty or too short.');
        }
        return result.value;
      } catch (error: unknown) {
        console.error('[AIResumeParser] Word document parsing failed:', error);
        throw new Error(`Failed to extract text from Word document: ${(error as Error).message}`);
      }
    } else if (mimeType === 'text/plain' || mimeType === 'application/json') {
      return fileBuffer.toString('utf-8');
    } else {
      console.warn(`[AIResumeParser] Unknown mime type: ${mimeType}, attempting to read as text.`);
      return fileBuffer.toString('utf-8');
    }
  }

  private getSampleResumeText(): string {
    return `John Doe
Software Engineer
john.doe@email.com | (555) 123-4567 | San Francisco, CA
LinkedIn: linkedin.com/in/johndoe | GitHub: github.com/johndoe

Professional Summary
Experienced full-stack software engineer with 5 years of experience building scalable web applications. 
Proficient in JavaScript, Python, and cloud technologies. Strong problem-solving skills and passion 
for creating efficient, user-friendly solutions.

Technical Skills
Programming Languages: JavaScript, TypeScript, Python, Java, Go
Frontend: React, Vue.js, Angular, HTML5, CSS3, SASS
Backend: Node.js, Express.js, Django, Flask, Spring Boot
Databases: PostgreSQL, MongoDB, Redis, MySQL
Cloud & DevOps: AWS, Docker, Kubernetes, Jenkins, Terraform
Tools: Git, Jira, Postman, VS Code

Professional Experience

Senior Software Engineer | Tech Startup Inc. | 2021 - Present
• Developed and maintained microservices architecture serving 1M+ users
• Led frontend development using React and TypeScript
• Implemented CI/CD pipelines reducing deployment time by 60%
• Mentored junior developers and conducted code reviews

Software Engineer | BigCorp Solutions | 2019 - 2021
• Built REST APIs using Node.js and Express.js
• Optimized database queries improving performance by 40%
• Collaborated with cross-functional teams on product features
• Participated in agile development processes

Education
Bachelor of Science in Computer Science | University of California | 2019
GPA: 3.8/4.0

Certifications
AWS Certified Solutions Architect
Google Cloud Professional Developer
Scrum Master Certified

Projects
E-commerce Platform | Personal Project
• Built full-stack e-commerce application using React and Node.js
• Integrated payment processing with Stripe API
• Deployed on AWS with auto-scaling capabilities

Languages
English (Native), Spanish (Conversational)`;
  }

  private async extractWithAI(text: string): Promise<AIExtractedData> {
    // Balanced approach: run rules and AI in parallel, use whichever succeeds
    // AI gets 15s max — if circuit breaker is open or provider is slow, rules win fast
    const rulePromise = this.extractWithFallback(text);
    const aiTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('AI enrichment timeout (15s)')), 15000)
    );
    const aiPromise = Promise.race([this.runAIEnrichment(text), aiTimeout]);

    const results = await Promise.allSettled([rulePromise, aiPromise]);
    const ruleResult = results[0];
    const aiResult = results[1];

    let winner: AIExtractedData;

    const isMeaningful = (d: AIExtractedData | undefined): boolean => {
      if (!d) return false;
      const totalSkills = (d.skills?.technical?.length || 0) +
        (d.skills?.tools?.length || 0) +
        (d.skills?.soft?.length || 0);
      return totalSkills > 0 || (d.experience?.positions?.length || 0) > 0;
    };

    if (aiResult.status === 'fulfilled' && isMeaningful(aiResult.value)) {
      console.log('[AIResumeParser] AI enrichment succeeded, using AI result');
      winner = aiResult.value;
    } else if (ruleResult.status === 'fulfilled' && isMeaningful(ruleResult.value)) {
      // AI failed or returned empty; rules have content — use rules.
      console.log('[AIResumeParser] AI returned empty or failed, using rule-based result');
      winner = ruleResult.value;
    } else if (aiResult.status === 'fulfilled') {
      // Both empty but AI structurally valid — fall back to it.
      winner = aiResult.value;
    } else if (ruleResult.status === 'fulfilled') {
      winner = ruleResult.value;
    } else {
      // Both failed - return a minimal valid structure
      console.error('[AIResumeParser] Both rules and AI failed:', ruleResult.reason, aiResult.reason);
      return {
        personalInfo: {},
        summary: '',
        skills: { technical: [], soft: [], tools: [] },
        experience: { totalYears: 0, level: 'entry', positions: [] },
        education: [],
        certifications: [],
        projects: [],
        languages: []
      };
    }

    // Domain coherence filter: applies to ALL paths (rules and AI).
    // If this looks like a CS/tech resume (>= 2 CS languages), strip
    // healthcare skills that LLMs hallucinate from noisy OCR text or
    // that rules infer from substring matches.
    return this.applyDomainCoherenceFilter(winner);
  }

  private applyDomainCoherenceFilter(result: AIExtractedData): AIExtractedData {
    // Broad tech-context detector — languages, cloud, DBs, DevOps, common tooling.
    // The previous narrow "CS_LANGUAGES" set missed obvious tech resumes whose
    // skills were mostly cloud/Azure/AWS/Git/Linux/SQL with only one language.
    const TECH_SIGNALS = new Set([
      // Languages
      'python','java','javascript','typescript','c++','c#','c','ruby',
      'go','rust','swift','kotlin','php','scala','r','.net',
      // Frameworks
      'react','node.js','angular','vue.js','django','flask','spring boot',
      'next.js','express.js','fastapi',
      // Cloud
      'aws','azure','gcp','google cloud',
      // Databases
      'sql','sql server','postgresql','mysql','mongodb','cassandra','redis',
      'dynamodb','sqlite',
      // DevOps / infra
      'docker','kubernetes','terraform','jenkins','ci/cd','linux','bash','shell',
      'git','github','gitlab','github actions',
      // Data / BI
      'power bi','tableau','snowflake','databricks','spark','pandas','numpy',
      // Tooling
      'jira','selenium','playwright','postman',
    ]);

    // Skills that are almost never genuinely held by someone with a tech resume.
    // AI parsers and the rule fallback both pull these in via context bleed
    // ("compliant with policies" → "Compliance/OSHA/Safety", "PC inventory" →
    // "Inventory Management"). Strip them when the resume is clearly tech.
    const NON_TECH_BLUECOLLAR_SKILLS = new Set([
      // Trades & construction
      'electrical','plumbing','carpentry','welding','hvac','roofing',
      'masonry','painting','landscaping','general labor','construction',
      'warehouse','forklift operation','blueprint reading',
      // Transportation
      'cdl','truck driver','delivery driver','rideshare driver','courier',
      // Retail & front-of-house
      'retail sales','cashier','sales','inventory management','stocking',
      'merchandising','cash handling','pos systems',
      // Food service & hospitality
      'food safety','food preparation','culinary arts','barista','line cook',
      'prep cook','housekeeping','janitorial','cleaning','handyman',
      'maintenance',
      // Security / safety / OSHA — only when resume is clearly tech
      'safety compliance','osha compliance','security','compliance',
      // Healthcare
      'patient care','bls certified','cpr certified',
      'hipaa compliance','electronic medical records','phlebotomy',
      'certified nursing assistant','nursing','medical assistant',
      'home health aide',
      // Finance/admin generic
      'auditing','accounting','bookkeeping','payroll','data entry',
      'clerical','receptionist',
    ]);

    const allSkills = [
      ...(result.skills?.technical || []),
      ...(result.skills?.tools || []),
    ];
    const techCount = allSkills.filter(s => TECH_SIGNALS.has(s.toLowerCase())).length;
    if (techCount >= 2) {
      result.skills.technical = result.skills.technical.filter(s => !NON_TECH_BLUECOLLAR_SKILLS.has(s.toLowerCase()));
      result.skills.tools = result.skills.tools.filter(s => !NON_TECH_BLUECOLLAR_SKILLS.has(s.toLowerCase()));
    }
    return result;
  }

  private async runAIEnrichment(text: string): Promise<AIExtractedData> {
    // Only try AI if we have API keys configured
    if (!process.env.GEMINI_API_KEY && !getGroqClient()) {
      throw new Error('No AI API keys configured');
    }

    // Try Groq first (free, fast)
    try {
      console.log('[AIResumeParser] Trying Groq API...');
      return await this.extractWithGroq(text);
    } catch (aiError: any) {
      console.warn('[AIResumeParser] Groq failed:', aiError.message);
    }

    // Try Ollama (local)
    if (process.env.USE_OLLAMA === 'true') {
      try {
        const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
        const ollamaModel = process.env.OLLAMA_MODEL || 'mistral';
        console.log('[AIResumeParser] Trying Ollama...');
        return await this.extractWithOllama(text, ollamaUrl, ollamaModel);
      } catch (ollamaError: any) {
        console.warn('[AIResumeParser] Ollama failed:', ollamaError.message);
      }
    }

    // Try Hugging Face
    const hfApiKey = process.env.HF_API_KEY;
    if (hfApiKey && hfApiKey !== '%HF_API_KEY%') {
      try {
        console.log('[AIResumeParser] Trying Hugging Face API...');
        return await this.extractWithHF(text, hfApiKey);
      } catch (hfError: any) {
        console.warn('[AIResumeParser] Hugging Face failed:', hfError.message);
      }
    }

    throw new Error('All AI providers failed');
  }

  private async extractWithHF(text: string, apiKey: string): Promise<AIExtractedData> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('HF API timeout (10s)')), 10000)
    );

    const response = await Promise.race([
      fetch('https://router.huggingface.co/hf-inference/models/mistralai/Mistral-7B-Instruct-v0.1/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'mistralai/Mistral-7B-Instruct-v0.1',
          messages: [
            { role: 'system', content: 'You are an expert resume parser. Extract structured data from resumes and return ONLY valid JSON with no other text.' },
            { role: 'user', content: `Extract the following information from this resume text and return as JSON:

{
  "personalInfo": { "name": "extracted name", "email": "extracted email", "phone": "extracted phone", "location": "extracted location", "linkedin": "linkedin url", "github": "github url", "portfolio": "portfolio url" },
  "summary": "professional summary text",
  "skills": { "technical": ["list of technical skills"], "soft": ["list of soft skills"], "tools": ["list of tools"] },
  "experience": { "totalYears": 0, "level": "entry|mid|senior|executive", "positions": [{ "title": "job title", "company": "company name", "duration": "time period", "responsibilities": ["responsibility1"] }] },
  "education": [{ "degree": "degree name", "institution": "school name", "year": "year" }],
  "certifications": ["cert1"],
  "projects": [{ "name": "project name", "description": "description", "technologies": ["tech1"] }],
  "languages": ["English"]
}

Resume text:
${text.slice(0, 8000)}` }
          ],
          max_tokens: 2000,
          temperature: 0.7,
        })
      }),
      timeoutPromise
    ]) as Response;

    if (!response.ok) {
      throw new Error(`HF API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '{}';
    let extractedData: any;
    try {
      extractedData = JSON.parse(content);
    } catch {
      throw new Error(`HF returned non-JSON response: ${content.slice(0, 200)}`);
    }

    return {
      personalInfo: extractedData.personalInfo || {},
      summary: extractedData.summary || '',
      skills: {
        technical: extractedData.skills?.technical || [],
        soft: extractedData.skills?.soft || [],
        tools: extractedData.skills?.tools || []
      },
      experience: {
        totalYears: extractedData.experience?.totalYears || 0,
        level: extractedData.experience?.level || 'entry',
        positions: extractedData.experience?.positions || []
      },
      education: extractedData.education || [],
      certifications: extractedData.certifications || [],
      projects: extractedData.projects || [],
      languages: extractedData.languages || []
    };
  }

  private async extractWithOllama(
    text: string,
    ollamaUrl: string,
    ollamaModel: string
  ): Promise<AIExtractedData> {
    console.log(`AIResumeParser: Calling Ollama model "${ollamaModel}"...`);

    const prompt = `You are an expert resume parser. Extract structured information from the following resume text and return ONLY valid JSON with no other text.

Resume text:
${text}

Return JSON with this exact structure:
{
  "personalInfo": {
    "name": "full name if found",
    "email": "email if found",
    "phone": "phone if found",
    "location": "location if found",
    "linkedin": "linkedin url if found",
    "github": "github url if found",
    "portfolio": "portfolio url if found"
  },
  "summary": "professional summary or objective if present",
  "skills": {
    "technical": ["list", "of", "technical", "skills"],
    "soft": ["list", "of", "soft", "skills"],
    "tools": ["list", "of", "tools", "and", "platforms"]
  },
  "experience": {
    "totalYears": 0,
    "level": "entry or mid or senior or executive",
    "positions": [
      {
        "title": "job title",
        "company": "company name",
        "duration": "time period",
        "responsibilities": ["responsibility1", "responsibility2"]
      }
    ]
  },
  "education": [
    {
      "degree": "degree name",
      "institution": "school/university name",
      "year": "graduation year",
      "gpa": "gpa if mentioned"
    }
  ],
  "certifications": ["cert1", "cert2"],
  "projects": [
    {
      "name": "project name",
      "description": "brief description",
      "technologies": ["tech1", "tech2"]
    }
  ],
  "languages": ["language1", "language2"]
}`;

    try {
      const response = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          prompt: prompt,
          stream: false,
          timeout: 120  // 2 minute timeout for local LLM
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama returned ${response.status}`);
      }

      const result = await response.json() as { response?: string };
      console.log('AIResumeParser: Ollama extraction complete');

      // Parse the response
      let extractedData;
      try {
        extractedData = JSON.parse(result.response || '{}');
      } catch (parseError: unknown) {
        console.warn('Failed to parse Ollama response, using fallback:', (parseError as Error).message);
        return this.extractWithFallback(text);
      }

      return {
        personalInfo: extractedData.personalInfo || {},
        summary: extractedData.summary || '',
        skills: extractedData.skills || { technical: [], soft: [], tools: [] },
        experience: extractedData.experience || { totalYears: 0, level: 'entry', positions: [] },
        education: extractedData.education || [],
        certifications: extractedData.certifications || [],
        projects: extractedData.projects || [],
        languages: extractedData.languages || []
      };
    } catch (error: unknown) {
      console.warn('Ollama extraction failed:', (error as Error).message);
      throw error;  // Will be caught by parent extractWithAI and trigger fallback
    }
  }

  private async extractWithGroq(text: string): Promise<AIExtractedData> {
    // Truncate large resumes to keep prompt size manageable (~8000 chars covers multi-page resumes)
    const truncatedText = text.length > 8000 ? text.substring(0, 8000) : text;
    if (text.length > 8000) {
      console.log(`[AIResumeParser] Truncated resume text from ${text.length} to 8000 chars`);
    }

    console.log('[AIResumeParser] Calling Groq directly...');

    const groqClient = getGroqClient();
    if (!groqClient) throw new Error('GROQ_API_KEY not set');

    const systemPrompt = 'You are an expert resume parser. Extract structured data from resumes and return ONLY valid JSON with no other text or markdown formatting.';
    const userPrompt = `Extract the following information from this resume text and return as JSON:

{
  "personalInfo": {
    "name": "extracted name",
    "email": "extracted email",
    "phone": "extracted phone",
    "location": "extracted location",
    "linkedin": "linkedin url",
    "github": "github url",
    "portfolio": "portfolio url"
  },
  "summary": "professional summary text",
  "skills": {
    "technical": ["list of technical skills"],
    "soft": ["list of soft skills"],
    "tools": ["list of tools and technologies"]
  },
  "experience": {
    "totalYears": 0,
    "level": "entry|mid|senior|executive",
    "positions": [
      {
        "title": "job title",
        "company": "company name",
        "duration": "time period",
        "responsibilities": ["list of responsibilities"]
      }
    ]
  },
  "education": [
    {
      "degree": "degree name",
      "institution": "school name",
      "year": "graduation year",
      "gpa": "gpa if mentioned"
    }
  ],
  "certifications": ["list of certifications"],
  "projects": [
    {
      "name": "project name",
      "description": "project description",
      "technologies": ["technologies used"]
    }
  ],
  "languages": ["spoken languages"]
}

Resume text:
${truncatedText}`;

    const completion = await throttledGroqRequest(
      () => groqClient.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 2500,
      }),
      'high',
      4000
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Groq returned no content');

    console.log('[AIResumeParser] AI response received, parsing JSON...');

    let extractedData;
    try {
      extractedData = JSON.parse(content || '{}');
    } catch (parseError: unknown) {
      console.warn('[AIResumeParser] Failed to parse AI response:', (parseError as Error).message);
      throw new Error('Failed to parse AI JSON response');
    }

    console.log('[AIResumeParser] Successfully extracted data via AI');

    // Ensure all required fields are present with defaults
    return {
      personalInfo: extractedData.personalInfo || {},
      summary: extractedData.summary || '',
      skills: {
        technical: extractedData.skills?.technical || [],
        soft: extractedData.skills?.soft || [],
        tools: extractedData.skills?.tools || []
      },
      experience: {
        totalYears: extractedData.experience?.totalYears || 0,
        level: extractedData.experience?.level || 'entry',
        positions: extractedData.experience?.positions || []
      },
      education: extractedData.education || [],
      certifications: extractedData.certifications || [],
      projects: extractedData.projects || [],
      languages: extractedData.languages || []
    };
  }

  private async extractWithFallback(text: string): Promise<AIExtractedData> {
    console.log('[AIResumeParser] Using Skill Intelligence Engine (deterministic fallback)');
    console.log(`[AIResumeParser] Text length: ${text.length} characters`);

    const result = parseResumeWithIntelligence(text);

    console.log(`[AIResumeParser] Skill Intelligence Engine: ${result.technical.length} technical, ${result.tools.length} tools, ${result.soft.length} soft skills. Confidence: ${result.confidence}%`);
    console.log(`[AIResumeParser] Top skills:`, [...result.technical, ...result.tools].slice(0, 10));

    const aiResult: AIExtractedData = {
      personalInfo: result.personalInfo,
      summary: this.extractSummary(text),
      skills: {
        technical: result.technical,
        soft:      result.soft,
        tools:     result.tools,
      },
      experience: {
        totalYears: result.totalYears,
        level:      result.experienceLevel,
        positions:  result.positions.map(p => ({ ...p, responsibilities: p.responsibilities ?? [] })),
      },
      education:       result.education,
      certifications:  result.certifications,
      projects:        this.extractProjects(text),
      languages:       this.extractLanguages(text),
    };
    return aiResult;
  }

  private extractPersonalInfo(text: string): AIExtractedData['personalInfo'] {
    const info: AIExtractedData['personalInfo'] = {};

    // Extract email (search whole doc)
    const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailMatch) {info.email = emailMatch[0];}

    // Extract phone (search whole doc)
    const phoneMatch = text.match(/(\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/);
    if (phoneMatch) {info.phone = phoneMatch[0];}

    // Extract LinkedIn URL
    const linkedinMatch = text.match(/linkedin\.com\/in\/[\w-]+/i);
    if (linkedinMatch) {info.linkedin = `https://${linkedinMatch[0]}`;}

    // Extract GitHub URL
    const githubMatch = text.match(/github\.com\/[\w-]+/i);
    if (githubMatch) {info.github = `https://${githubMatch[0]}`;}

    // Extract name: scan first 8 non-empty lines; skip lines that look like
    // job titles, contact info, URLs, or section headers.
    const JOB_TITLE_WORDS = /\b(engineer|developer|manager|analyst|designer|consultant|director|officer|specialist|coordinator|architect|intern|associate|lead|senior|junior|staff|president|chief|head|vp|cto|ceo|coo|resume|curriculum|vitae)\b/i;
    const headerLines = text.split('\n').slice(0, 12).map(l => l.trim()).filter(Boolean);
    for (const line of headerLines) {
      if (/[@\d|()•\\/]|linkedin|github|http|\.com|\.edu|\.org/i.test(line)) {continue;}
      if (JOB_TITLE_WORDS.test(line)) {continue;}
      // 2–4 words, each starting with a capital letter, no punctuation
      if (/^([A-Z][a-zA-Z'-]{1,20}\s){1,3}[A-Z][a-zA-Z'-]{1,20}$/.test(line)) {
        info.name = line;
        break;
      }
    }

    // Extract location: only search the first 20 lines to avoid matching
    // skill/company names deeper in the document.
    const headerText = text.split('\n').slice(0, 20).join('\n');
    const locationPatterns = [
      /([A-Z][a-z]{2,},\s*[A-Z]{2}(?:\s+\d{5})?)/,  // City, ST  or  City, ST 12345
      /Location:\s*([^\n,]{3,40})/i,
    ];
    for (const pattern of locationPatterns) {
      const match = headerText.match(pattern);
      if (match) {
        info.location = match[1].trim();
        break;
      }
    }

    return info;
  }

  private extractSummary(text: string): string {
    const summaryKeywords = ['summary', 'objective', 'profile', 'about', 'overview'];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (summaryKeywords.some(keyword => line.includes(keyword))) {
        // Extract next few lines as summary
        const summaryLines = [];
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const nextLine = lines[j].trim();
          if (nextLine && !this.isNewSection(nextLine)) {
            summaryLines.push(nextLine);
          } else {
            break;
          }
        }
        return summaryLines.join(' ');
      }
    }

    // If no explicit summary, take first substantial paragraph
    const paragraphs = text.split('\n\n');
    for (const paragraph of paragraphs) {
      if (paragraph.length > 100 && paragraph.length < 500) {
        return paragraph.trim();
      }
    }

    return '';
  }

  private extractSkillsAI(text: string): AIExtractedData['skills'] {
    const textLower = text.toLowerCase();
    const skills = {
      technical: [] as string[],
      soft: [] as string[],
      tools: [] as string[]
    };

    // Find technical skills
    this.skillsDatabase.forEach(skill => {
      const skillPattern = new RegExp(`\\b${skill.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      if (skillPattern.test(text)) {
        skills.technical.push(skill);
      }
    });

    // Find soft skills
    this.softSkills.forEach(skill => {
      const skillPattern = new RegExp(`\\b${skill.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      if (skillPattern.test(text)) {
        skills.soft.push(skill);
      }
    });

    // Extract skills from dedicated sections
    const skillsSection = this.extractSection(text, ['skills', 'technical skills', 'technologies', 'tools', 'competencies']);
    if (skillsSection) {
      const extractedSkills = this.parseSkillsSection(skillsSection);
      skills.technical.push(...extractedSkills.filter(s => !skills.technical.includes(s)));
    }

    return {
      technical: Array.from(new Set(skills.technical)).slice(0, 25),
      soft: Array.from(new Set(skills.soft)).slice(0, 10),
      tools: Array.from(new Set(skills.tools)).slice(0, 15)
    };
  }

  private extractExperienceAI(text: string): AIExtractedData['experience'] {
    const positions = this.extractWorkHistory(text);
    const totalYears = this.calculateTotalExperience(text, positions);

    let level: 'entry' | 'mid' | 'senior' | 'executive' = 'entry';
    if (totalYears >= 10) {level = 'executive';}
    else if (totalYears >= 5) {level = 'senior';}
    else if (totalYears >= 2) {level = 'mid';}

    return {
      totalYears,
      level,
      positions
    };
  }

  private extractWorkHistory(text: string): Array<{ title: string; company: string; duration: string; responsibilities: string[] }> {
    const positions = [];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Look for job title patterns
      const titlePattern = /(Software Engineer|Developer|Manager|Analyst|Designer|Consultant|Director|VP|CEO|CTO|Lead|Senior|Junior|Intern)/i;
      const datePattern = /\b\d{4}\b.*?(?:present|current|\d{4})/i;

      if (titlePattern.test(line) && (datePattern.test(line) || datePattern.test(lines[i + 1] || ''))) {
        const title = line;
        const company = this.extractCompanyFromLine(lines[i + 1] || '');
        const duration = this.extractDurationFromLines([line, lines[i + 1] || '', lines[i + 2] || '']);
        const responsibilities = this.extractResponsibilities(lines, i + 2);

        positions.push({
          title: title
            .replace(datePattern, '')     // remove date range
            .replace(/\s*[–—]\s*.+$/, '')     // truncate at em-dash/en-dash before description
            .replace(/@.*$/, '')          // truncate at @ artifact (PDF layout separator)
            .replace(/\s*\(\s*\)/g, '')   // remove empty parens left after date removal
            .replace(/^[-–—•*]\s*/, '')   // strip leading bullet/dash
            .replace(/\s{2,}/g, ' ')      // collapse multiple spaces
            .trim(),
          company,
          duration,
          responsibilities
        });
      }
    }

    return positions.slice(0, 10); // Limit to 10 positions
  }

  private extractEducation(text: string): Array<{ degree: string; institution: string; year?: string; gpa?: string }> {
    const education = [];
    const educationSection = this.extractSection(text, ['education', 'academic', 'university', 'college']);

    if (educationSection) {
      const lines = educationSection.split('\n').map(l => l.trim()).filter(Boolean);
      // Require degree words to appear at line start or in a clear degree context.
      // "Master's" / "Master of" are degrees; "Master System" is not.
      const degreePattern = /\b(B\.S\.|B\.A\.|M\.S\.|M\.A\.|Ph\.D\.|MBA|Associate\s+of|Bachelor(?:\s+of)?|Master(?:'s|\s+of\s)|PhD)\b/i;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!degreePattern.test(line)) {continue;}
        // Skip lines that are clearly sentence fragments from experience bullets
        if (line.split(' ').length > 12) {continue;}

        const yearMatch = line.match(/\b(19|20)\d{2}\b/);
        const gpaMatch = line.match(/GPA:?\s*(\d\.\d+)/i);
        // Institution is often the next line
        const institutionLine = lines[i + 1] || '';
        const institution = this.extractInstitutionFromLine(line) ||
          (institutionLine && !degreePattern.test(institutionLine) ? institutionLine : '');

        education.push({
          degree: line,
          institution,
          year: yearMatch ? yearMatch[0] : undefined,
          gpa: gpaMatch ? gpaMatch[1] : undefined,
        });
      }
    }

    return education;
  }

  private extractCertifications(text: string): string[] {
    const certifications: string[] = [];
    const certSection = this.extractSection(text, ['certifications', 'certificates', 'licenses']);

    if (certSection) {
      const lines = certSection.split('\n').filter(line => line.trim().length > 0);
      certifications.push(...lines.slice(0, 10));
    }

    // Common certification patterns
    const certPatterns = [
      /AWS Certified/gi,
      /Google Cloud/gi,
      /Microsoft Certified/gi,
      /Cisco Certified/gi,
      /Oracle Certified/gi,
      /PMP/gi,
      /Agile/gi,
      /Scrum Master/gi
    ];

    certPatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        certifications.push(...matches);
      }
    });

    return Array.from(new Set(certifications)).slice(0, 10);
  }

  private extractProjects(text: string): Array<{ name: string; description: string; technologies: string[] }> {
    const projects = [];
    const projectSection = this.extractSection(text, ['projects', 'portfolio', 'personal projects']);

    if (projectSection) {
      const projectBlocks = projectSection.split(/\n\s*\n/);

      for (const block of projectBlocks) {
        if (block.trim().length > 20) {
          const lines = block.split('\n');
          const name = lines[0].trim();
          const description = lines.slice(1).join(' ').trim();
          const technologies = this.extractTechnologiesFromText(description);

          projects.push({
            name,
            description,
            technologies
          });
        }
      }
    }

    return projects.slice(0, 5);
  }

  private extractLanguages(text: string): string[] {
    const languages: string[] = [];
    const langSection = this.extractSection(text, ['languages', 'language skills']);

    if (langSection) {
      const commonLanguages = ['English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese', 'Korean', 'Italian', 'Portuguese', 'Russian', 'Arabic', 'Hindi'];

      commonLanguages.forEach(lang => {
        if (new RegExp(`\\b${lang}\\b`, 'i').test(langSection)) {
          languages.push(lang);
        }
      });
    }

    return languages;
  }

  // Helper methods
  private extractSection(text: string, keywords: string[]): string | null {
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (keywords.some(keyword => line.includes(keyword))) {
        const sectionLines = [];
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j];
          if (this.isNewSection(nextLine)) {
            break;
          }
          sectionLines.push(nextLine);
        }
        return sectionLines.join('\n');
      }
    }

    return null;
  }

  private isNewSection(line: string): boolean {
    const sectionKeywords = ['experience', 'education', 'skills', 'projects', 'certifications', 'awards', 'references'];
    const lineLower = line.toLowerCase().trim();
    return sectionKeywords.some(keyword => lineLower === keyword || lineLower.endsWith(keyword));
  }

  private parseSkillsSection(section: string): string[] {
    // Tokens that look like skills but are noise (OS versions, pronouns, etc.)
    const NOISE = new Set([
      'xp', 'nt', 'me', '9x', '98', '95', 'sp', 'ms', 'pc', 'os', 'ie',
      'the', 'and', 'or', 'etc', 'other', 'various', 'including', 'such',
      'packages', 'methodologies', 'tools', 'systems', 'languages', 'skills',
      'technologies', 'frameworks', 'libraries', 'platforms', 'software',
    ]);

    const skills: string[] = [];
    const lines = section.split('\n');

    for (const line of lines) {
      // Strip a category label before a colon, e.g. "Languages: Java, C++" → "Java, C++"
      const valuesPart = /^[^:]{1,40}:(.+)$/.test(line.trim())
        ? line.trim().replace(/^[^:]+:/, '')
        : line;

      // Do NOT split on "/" — preserves compound skills like HP/UX, React/Redux
      const tokens = valuesPart
        .split(/[,•·‣▪▫|]/)
        .map(s => s.trim()
          .replace(/^[-–—]\s*/, '')   // strip leading bullet/dash
          .replace(/:$/, '')          // strip trailing colon (e.g. "Tools:")
        )
        .filter(s => {
          if (s.length < 2 || s.length > 40) {return false;}
          if (/^\d+$/.test(s)) {return false;}           // pure numbers
          if (NOISE.has(s.toLowerCase())) {return false;}
          // Drop tokens where every slash-part is a noise word
          if (s.includes('/') && s.split('/').every(p => NOISE.has(p.toLowerCase()) || p.length < 2)) {return false;}
          return true;
        });

      skills.push(...tokens);
    }

    return skills;
  }

  private calculateTotalExperience(text: string, positions: any[]): number {
    // Try to find explicit experience mentions
    const experiencePatterns = [
      /(\d+)\+?\s*years?\s*of\s*experience/gi,
      /(\d+)\+?\s*years?\s*in/gi,
      /(\d+)\+?\s*yrs?\s*experience/gi
    ];

    for (const pattern of experiencePatterns) {
      const match = text.match(pattern);
      if (match) {
        const years = match[0].match(/\d+/);
        if (years) {
          return parseInt(years[0]);
        }
      }
    }

    // Calculate from work history if available
    if (positions.length > 0) {
      let totalMonths = 0;

      positions.forEach(position => {
        const duration = this.parseDuration(position.duration);
        totalMonths += duration;
      });

      return Math.round(totalMonths / 12);
    }

    return 0;
  }

  private parseDuration(duration: string): number {
    const yearMatch = duration.match(/(\d+)\s*years?/i);
    const monthMatch = duration.match(/(\d+)\s*months?/i);

    let months = 0;
    if (yearMatch) {months += parseInt(yearMatch[1]) * 12;}
    if (monthMatch) {months += parseInt(monthMatch[1]);}

    return months || 12; // Default to 1 year if no duration found
  }

  private extractCompanyFromLine(line: string): string {
    // Remove common patterns to isolate company name
    return line.replace(/\b\d{4}\b.*?(?:present|current|\d{4})/gi, '').trim();
  }

  private extractDurationFromLines(lines: string[]): string {
    for (const line of lines) {
      const datePattern = /\b\d{4}\b.*?(?:present|current|\d{4})/i;
      const match = line.match(datePattern);
      if (match) {
        return match[0];
      }
    }
    return '';
  }

  private extractResponsibilities(lines: string[], startIndex: number): string[] {
    const responsibilities = [];

    for (let i = startIndex; i < Math.min(startIndex + 10, lines.length); i++) {
      const line = lines[i].trim();
      if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
        responsibilities.push(line.replace(/^[•\-*]\s*/, ''));
      } else if (this.isNewSection(line) || line.length < 10) {
        break;
      }
    }

    return responsibilities;
  }

  private extractInstitutionFromLine(line: string): string {
    const parts = line.split(/[,\n]/);
    for (const part of parts) {
      if (part.toLowerCase().includes('university') ||
        part.toLowerCase().includes('college') ||
        part.toLowerCase().includes('institute')) {
        return part.trim();
      }
    }
    return parts[parts.length - 1]?.trim() || '';
  }

  private extractTechnologiesFromText(text: string): string[] {
    const technologies: string[] = [];

    this.skillsDatabase.forEach(skill => {
      if (text.toLowerCase().includes(skill.toLowerCase())) {
        technologies.push(skill);
      }
    });

    return technologies.slice(0, 10);
  }

  private calculateConfidence(data: AIExtractedData): number {
    let score = 0;
    let maxScore = 0;

    // Personal info (20 points max)
    maxScore += 20;
    if (data.personalInfo.name) {score += 5;}
    if (data.personalInfo.email) {score += 5;}
    if (data.personalInfo.phone) {score += 3;}
    if (data.personalInfo.location) {score += 3;}
    if (data.personalInfo.linkedin) {score += 2;}
    if (data.personalInfo.github) {score += 2;}

    // Skills (25 points max)
    maxScore += 25;
    score += Math.min(data.skills.technical.length * 2, 20);
    score += Math.min(data.skills.soft.length, 5);

    // Experience (25 points max)
    maxScore += 25;
    score += Math.min(data.experience.positions.length * 5, 20);
    if (data.experience.totalYears > 0) {score += 5;}

    // Education (15 points max)
    maxScore += 15;
    score += Math.min(data.education.length * 7, 15);

    // Other (15 points max)
    maxScore += 15;
    if (data.summary) {score += 5;}
    score += Math.min(data.certifications.length * 2, 5);
    score += Math.min(data.projects.length * 1, 5);

    return Math.round((score / maxScore) * 100);
  }
}

export const aiResumeParser = new AIResumeParser();