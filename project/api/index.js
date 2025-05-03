require('dotenv').config();
const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Put web assets in /api-docs folder
app.use('/api-docs', express.static(path.join(__dirname, '../web')));

// Serve webpage at /api-docs
app.get('/api-docs', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/index.html'));
});

const swaggerDocument = yaml.load(fs.readFileSync(path.join(__dirname, '../web/swagger.yaml'), 'utf8'));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Set up Logging
const accessLogStream = fs.createWriteStream(
  path.join(__dirname, 'access.log'),
  { flags: 'a' }
);
app.use(morgan('combined', { stream: accessLogStream }));

// API Key middleware to all routes except `/api-docs`
const apiKeyMiddleware = (req, res, next) => {
  if (req.originalUrl !== '/api-docs' && req.originalUrl !== '/swagger.yaml') {
    const apiKey = req.headers['x-api-key'];

    //Missing Key
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing API Key.' });
    }

    //Invalid Key
    if (apiKey !== process.env.API_KEY) {
      return res.status(403).json({ error: 'Invalid API Key.' });
    }
  }
  next();
};

// Apply the API Key
app.use(apiKeyMiddleware);

// Function to check content type and image_url
const validateRequest = (req, res, next) => {
  const contentType = req.headers['content-type'];
  let errors = [];

   // Check if Content-Type is missing or incorrect
   if (contentType && contentType !== 'application/json') {
    return res.status(415).json({
      message: 'Unsupported Media Type. Please use Content-Type: application/json',
      details: `Received Content-Type: ${contentType}`,
    });
  }

  // Check for image_url in request body
  if (!req.body || !req.body.image_url) {
    return res.status(400).json({ error: "Missing 'image_url' in request body." });
  }


  // If no errors, continue
  next();
};

// Map Azure Errors to Custom Errors
const mapAzureError = (azureError) => {
  const innerError = azureError?.error?.innererror;
  const code = innerError?.code || azureError?.error?.code;
  const message = innerError?.message || azureError?.error?.message || 'Azure API Error';
  const errorMap = {
    InvalidImageUrl: { status: 400, message: 'The image URL is improperly formatted or inaccessible.' },
    InvalidImageFormat: { status: 400, message: 'The image format is invalid or not supported.' },
    InvalidImageSize: { status: 400, message: 'The image is too large to process.' },
    NotSupportedVisualFeature: { status: 400, message: 'The specified visual feature is not supported.' },
    NotSupportedImage: { status: 400, message: 'The image is not supported (e.g. contains illegal content).' },
    InvalidDetails: { status: 400, message: 'Unsupported parameter value.' },
    BadArgument: { status: 400, message: 'The request contains an invalid argument.' },
    UnsupportedMediaType: {status: 415, message: 'The media type of the request is not supported. Ensure you are using the correct `Content-Type` header.'},
    FailedToProcess: { status: 500, message: 'Azure failed to process the image.' },
    Timeout: { status: 500, message: 'Image processing timed out.' },
    InternalServerError: { status: 500, message: 'Azure encountered an internal error.' }
  };

  return errorMap[code] || { status: 502, message: message, code };
};

// Azure image analysis utility function with error handling
const analyzeImage = async (imageUrl, visualFeatures) => {
  try {
    const azureResponse = await axios.post(
      `${process.env.AZURE_ENDPOINT}/vision/v3.2/analyze`,
      { url: imageUrl },
      {
        params: {
          visualFeatures,
          language: 'en',
        },
        headers: {
          'Ocp-Apim-Subscription-Key': process.env.AZURE_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
    return azureResponse.data;
  } catch (err) {
    if (err.response) {
      // Azure responded with an error status
      const status = err.response.status;
      const errorData = err.response.data;

      // Rate limit error
      if (status === 429) {
        throw {
          status: 429,
          message: "Rate limit exceeded. Please wait before making more requests.",
          retryAfter: err.response.headers['retry-after'] || "Try again in 60 seconds."
        };
      } 

      const mapped = mapAzureError(errorData);
      throw {
        status: mapped.status,
        message: mapped.message,
        code: errorData.error?.code,
        details: process.env.NODE_ENV === 'development' ? errorData : undefined
      };
    } else {
        // Other kinds of errors
        throw {
          status: 500,
          message: "Internal server error",
          details: err.message,
        };
    } 
  }
};

// Tags endpoint
app.post('/tags', validateRequest, async (req, res) => {
  const imageUrl = req.body.image_url;

  try {
    const data = await analyzeImage(imageUrl, 'Tags');
    res.json({ tags: data.tags });
  } catch (err) {
    // Rate Limit Error
    if (err.error && err.status === 429) {
      res.status(429).json({
        error: err.message,
        retryAfter: err.retryAfter
      });
    } else {
      // Internal Server Error
      res.status(err.status || 500).json({
        error: err.message,
        details: err.details
      });
    }    
  }
});

// Objects endpoint
app.post('/objects', validateRequest, async (req, res) => {
  const imageUrl = req.body.image_url;

  try {
    const data = await analyzeImage(imageUrl, 'Objects');
    res.json({ objects: data.objects });
  } catch (err) {
    // Rate Limit Error
    if (err.error && err.status === 429) {
      res.status(429).json({
        error: err.message,
        retryAfter: err.retryAfter
      });
    } else {
      // Internal Server Error
      res.status(err.status || 500).json({
        error: err.message,
        details: err.details
      });
    }    
  }
});

// Description endpoint
app.post('/description', validateRequest, async (req, res) => {
  const imageUrl = req.body.image_url;

  try {
    const data = await analyzeImage(imageUrl, 'Description');
    res.json({ description: data.description });
  } catch (err) {
    // Rate Limit Error
    if (err.error && err.status === 429) {
      res.status(429).json({
        error: err.message,
        retryAfter: err.retryAfter
      });
    } else {
      // Internal Server Error
      res.status(err.status || 500).json({
        error: err.message,
        details: err.details
      });
    }    
  }
});

// Metadata endpoint
app.post('/metadata', validateRequest, async (req, res) => {
  const imageUrl = req.body.image_url;
  
  try {
    const data = await analyzeImage(imageUrl, 'Description');
    const metadata = {
      height: data.metadata.height,
      width: data.metadata.width,
      format: data.metadata.format,
    };
    res.json({ metadata });
  } catch (err) {
    // Rate Limit Error
    if (err.error && err.status === 429) {
      res.status(429).json({
        error: err.message,
        retryAfter: err.retryAfter
      });
    } else {
      //Internal Server Error
      res.status(err.status || 500).json({
        error: err.message,
        details: err.details
      });
    }    
  }
});


app.listen(3000, () => {
  console.log('Server running on port 3000');
  console.log('API documentation available at /api-docs');
});
