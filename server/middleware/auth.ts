import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

export const isAuthenticated = async (req: Request, res: Response, next: NextFunction) => {
  let token: string | undefined;

  // 1. Try to get the token from the Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // 2. If not in header, try to get it from cookies (for browser-based clients)
  if (!token && req.cookies && req.cookies['sb-access-token']) {
    token = req.cookies['sb-access-token'];
  }

  if (!token) {
    console.log('isAuthenticated: No token found');
    return res.status(401).json({ message: 'Unauthorized: No token provided' });
  }

  try {
    if (!JWT_SECRET) {
      console.error('isAuthenticated: SUPABASE_JWT_SECRET is not configured');
      return res.status(500).json({ message: 'Server authentication configuration error' });
    }

    // Verify JWT signature and decode payload
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as any;

    // Validate token has required fields and that the user ID is a string
    const userId: string | undefined = payload.sub || payload.user_id;
    if (!userId) {
      console.warn('isAuthenticated: Token missing user ID');
      return res.status(401).json({ message: 'Unauthorized: Invalid token payload' });
    }
    if (typeof userId !== 'string') {
      console.warn('isAuthenticated: User ID is not a string', typeof userId);
      return res.status(401).json({ message: 'Unauthorized: Invalid token payload' });
    }

    // Create user object from JWT payload
    const user = {
      id: userId,
      email: payload.email,
      // Seconds since epoch. Lets callers tell a token minted after a change
      // (e.g. a confirmed email change) from an older one still in use.
      issuedAt: typeof payload.iat === 'number' ? payload.iat : undefined,
      user_metadata: payload.user_metadata || {},
      app_metadata: payload.app_metadata || {},
    };

    (req as any).user = user;
    console.log('isAuthenticated: User authenticated:', user.id);
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      console.warn('isAuthenticated: Token expired');
      return res.status(401).json({ message: 'Unauthorized: Token expired' });
    }
    if (error instanceof jwt.JsonWebTokenError) {
      console.warn('isAuthenticated: Invalid token signature');
      return res.status(401).json({ message: 'Unauthorized: Invalid token' });
    }
    console.error('isAuthenticated: Error during authentication:', error);
    return res.status(500).json({ message: 'Internal server error during authentication' });
  }
};
