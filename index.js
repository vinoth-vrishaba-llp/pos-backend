import "./env.js"; // 👈 MUST be first

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import routes from "./routes.js";
import { apiLimiter } from "./rateLimit.js";
import { startCronJobs } from "./cron.js";


console.log("ENV CHECK:", {
  BASEROW_BASE_URL: process.env.BASEROW_BASE_URL,
  WOO_BASE_URL: process.env.WOO_BASE_URL,
});



const app = express();

// Secure CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

startCronJobs();

app.use(express.json());
app.use(cookieParser());


app.use("/api", apiLimiter, routes);


app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(process.env.PORT, () =>
  console.log(`Backend running on ${process.env.PORT}`)
);
