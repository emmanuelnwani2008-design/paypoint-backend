const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');
const morgan = require('morgan');

function createSecurity(app, opts = {}) {
  const { allowedOrigins = ['http://localhost:3000'], rate = { windowMs: 15 * 60 * 1000, max: 100 } } = opts;

  app.use(helmet());
  app.use(morgan('combined'));

  // CORS - restrict to allowed origins
  const corsOptions = {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };

  app.use(cors(corsOptions));

  // Basic rate limiter
  const limiter = rateLimit({
    windowMs: rate.windowMs,
    max: rate.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
  });

  app.use(limiter);

  // Basic XSS cleaning
  app.use(xss());

  return app;
}

module.exports = { createSecurity };