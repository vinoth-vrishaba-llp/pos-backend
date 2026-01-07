import rateLimit from "express-rate-limit";

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120,               // 120 requests / minute / IP
  standardHeaders: true,
  legacyHeaders: false
});
