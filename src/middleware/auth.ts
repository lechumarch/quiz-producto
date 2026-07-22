import { Request, Response, NextFunction } from 'express';
import { getSecret } from '../secrets';

export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Quiz Admin"');
    res.status(401).send('Unauthorized');
    return;
  }
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');

  // Multi-user: ADMIN_USERS = '[{"user":"x","pass":"y"},...]'
  const adminUsersRaw = getSecret('ADMIN_USERS');
  let authorized = false;
  if (adminUsersRaw) {
    try {
      const users: { user: string; pass: string }[] = JSON.parse(adminUsersRaw);
      authorized = users.some(u => u.user === user && u.pass === pass);
    } catch { /* fall through to single-user check */ }
  }
  if (!authorized) {
    // Support both ADMIN_USER/ADMIN_PASS (Ownia) and BASIC_AUTH_USER/BASIC_AUTH_PASS (home server)
    const adminUser = getSecret('ADMIN_USER') ?? getSecret('BASIC_AUTH_USER');
    const adminPass = getSecret('ADMIN_PASS') ?? getSecret('BASIC_AUTH_PASS');
    authorized = user === adminUser && pass === adminPass;
  }

  if (authorized) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Quiz Admin"');
    res.status(401).send('Unauthorized');
  }
}
