const express = require('express');
const axios = require('axios');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());

app.use(express.static(path.join(__dirname)));

const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/**
 * Main endpoint to get stock data and AI analysis
 */
app.get('/api/stock/:ticker', async (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        // Add this line to get the range parameter
        const range = req.query.range || '1d'; // Default to 1 day if not specified
        
        // Update this line to pass the range parameter
        const stockData = await fetchStockData(ticker, range);
        
        // Get AI analysis based on stock data
        const aiAnalysis = await generateAIAnalysis(ticker, stockData);
        
        // Return combined data
        res.json({
            stockData,
            aiAnalysis
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ 
            error: error.message || 'Failed to process stock data'
        });
    }
});

/**
 * Fetch stock data from Alpha Vantage API
 * @param {string} query - The stock ticker symbol or company name
 * @returns {object} Processed stock data
 */
async function fetchStockData(query, range = '1d') {
    try {
        let ticker = query.trim().toUpperCase();
        
        // If the query looks like a company name rather than a ticker
        if (ticker.length > 5 && ticker.includes(' ')) {
            // Try to find the ticker symbol using Symbol Search endpoint
            const searchResponse = await axios.get(
                `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${ALPHA_VANTAGE_API_KEY}`
            );
            
            if (searchResponse.data && 
                searchResponse.data.bestMatches && 
                searchResponse.data.bestMatches.length > 0) {
                // Get the first (best) match
                ticker = searchResponse.data.bestMatches[0]['1. symbol'];
                console.log(`Resolved company name "${query}" to ticker "${ticker}"`);
            } else {
                throw new Error(`Could not find a ticker symbol for "${query}"`);
            }
        }
        
        // Determine the appropriate Alpha Vantage function and data points based on range
        let alphavantageFunction;
        let dataPointsToRetrieve;
        let formatDateFunction = formatDate;
        
        switch(range) {
            case '1d':
                alphavantageFunction = 'TIME_SERIES_INTRADAY';
                dataPointsToRetrieve = 24; // Hourly data points for 1 day
                formatDateFunction = formatIntraday;
                var interval = '&interval=60min';
                break;
            case '1w':
                alphavantageFunction = 'TIME_SERIES_DAILY';
                dataPointsToRetrieve = 7; // Data points for 1 week
                break;
            case '1m':
                alphavantageFunction = 'TIME_SERIES_DAILY';
                dataPointsToRetrieve = 30; // Data points for 1 month
                break;
            case '3m':
                alphavantageFunction = 'TIME_SERIES_DAILY';
                dataPointsToRetrieve = 90; // Data points for 3 months
                break;
            case '6m':
                alphavantageFunction = 'TIME_SERIES_DAILY';
                dataPointsToRetrieve = 180; // Data points for 6 months
                break;
            case '1y':
                alphavantageFunction = 'TIME_SERIES_WEEKLY';
                dataPointsToRetrieve = 52; // Weekly data points for 1 year
                formatDateFunction = formatWeekly;
                break;
            case '5y':
                alphavantageFunction = 'TIME_SERIES_MONTHLY';
                dataPointsToRetrieve = 60; // Monthly data points for 5 years
                formatDateFunction = formatMonthly;
                break;
            default:
                alphavantageFunction = 'TIME_SERIES_DAILY';
                dataPointsToRetrieve = 7; // Default to 1 week
        }
        
        // Build the API URL based on the function
        let apiUrl = `https://www.alphavantage.co/query?function=${alphavantageFunction}&symbol=${ticker}${interval || ''}&apikey=${ALPHA_VANTAGE_API_KEY}`;
        if (alphavantageFunction === 'TIME_SERIES_INTRADAY') {
            apiUrl += '&outputsize=full'; // Get full data for intraday
        }
        
        // Fetch data from Alpha Vantage
        const response = await axios.get(apiUrl);
        const data = response.data;
        
        // Check if we got valid data
        if (data['Error Message']) {
            throw new Error(`Invalid ticker symbol: ${ticker}`);
        }
        
        // Determine the correct time series key based on the function
        let timeSeriesKey;
        switch(alphavantageFunction) {
            case 'TIME_SERIES_INTRADAY':
                timeSeriesKey = 'Time Series (60min)';
                break;
            case 'TIME_SERIES_DAILY':
                timeSeriesKey = 'Time Series (Daily)';
                break;
            case 'TIME_SERIES_WEEKLY':
                timeSeriesKey = 'Weekly Time Series';
                break;
            case 'TIME_SERIES_MONTHLY':
                timeSeriesKey = 'Monthly Time Series';
                break;
        }
        
        if (!data[timeSeriesKey]) {
            throw new Error('No data available for this ticker');
        }
        
        // Get company name (using overview endpoint)
        let companyName = ticker;
        try {
            const companyResponse = await axios.get(
                `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${ALPHA_VANTAGE_API_KEY}`
            );
            if (companyResponse.data.Name) {
                companyName = companyResponse.data.Name;
            }
        } catch (error) {
            console.warn('Could not fetch company name:', error.message);
        }
        
        // Process time series data
        const timeSeriesData = data[timeSeriesKey];
        const dates = Object.keys(timeSeriesData).sort((a, b) => new Date(a) - new Date(b));
        
        // Get appropriate number of data points based on range
        const relevantDates = dates.slice(-dataPointsToRetrieve);
        
        // Format data for chart and analysis
        const timeSeries = relevantDates.map(date => {
            const dayData = timeSeriesData[date];
            return {
                date: formatDateFunction(date),
                open: parseFloat(dayData['1. open']),
                high: parseFloat(dayData['2. high']),
                low: parseFloat(dayData['3. low']),
                close: parseFloat(dayData['4. close']),
                volume: parseInt(dayData['5. volume'])
            };
        });
        
        // Calculate price change based on the selected range
        const currentPrice = parseFloat(timeSeriesData[dates[dates.length - 1]]['4. close']);
        const previousIndex = Math.max(0, dates.length - dataPointsToRetrieve - 1);
        const previousPrice = parseFloat(timeSeriesData[dates[previousIndex]] ? 
            timeSeriesData[dates[previousIndex]]['4. close'] : 
            timeSeriesData[dates[0]]['4. close']);
        
        const priceChange = currentPrice - previousPrice;
        const percentChange = (priceChange / previousPrice) * 100;
        
        return {
            symbol: ticker,
            name: companyName,
            current: currentPrice,
            previous: previousPrice,
            change: priceChange,
            percentChange: percentChange,
            timeSeries: timeSeries
        };
    } catch (error) {
        console.error('Error fetching stock data:', error);
        throw new Error(`Failed to fetch stock data: ${error.message}`);
    }
}
function formatDate(dateString) {
    const date = new Date(dateString);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day}`;  // Should produce formats like "4/15"
}

function formatIntraday(dateString) {
    const date = new Date(dateString);
    const hours = date.getHours();
    const formattedHours = hours % 12 || 12; // Convert to 12-hour format
    const ampm = hours >= 12 ? 'PM' : 'AM';
    return `${formattedHours}${ampm}`;  // Should produce formats like "2PM"
}

function formatWeekly(dateString) {
    const date = new Date(dateString);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day}`;
}

function formatMonthly(dateString) {
    const date = new Date(dateString);
    const month = date.getMonth() + 1;
    const year = date.getFullYear();
    return `${month}/${year}`;
}
/**
 * Generate AI analysis using Google Gemini
 * @param {string} ticker - The stock ticker symbol
 * @param {object} stockData - Processed stock data
 * @returns {string} HTML-formatted AI analysis
 */
async function generateAIAnalysis(ticker, stockData) {
    try {
        // Create a prompt with the stock data
        const prompt = `
        Please analyze the following stock data for ${ticker} (${stockData.name}) over the past week:
        
        Current Price: $${stockData.current.toFixed(2)}
        Price Change: ${stockData.percentChange > 0 ? '+' : ''}${stockData.percentChange.toFixed(2)}%
        
        Daily closing prices (from oldest to newest):
        ${stockData.timeSeries.map(day => `${day.date}: $${day.close.toFixed(2)}`).join('\n')}
        
        Based on this data, provide a concise analysis (about 150 words) of ${ticker}'s performance over the past week. 
        Include key patterns, significant price movements, and potential factors that might have influenced the stock.
        Format your response in HTML paragraphs (<p> tags) for direct display on a webpage.
        `;
        
        // Initialize Gemini model - updated to use the correct model name
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        
        // Generate content
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Return the response as HTML
        return text;
    } catch (error) {
        console.error('Error generating AI analysis:', error);
        return `<p>Unable to generate AI analysis at this time. Please try again later.</p>
                <p>Stock data is still available for your review.</p>`;
    }
}

/**
 * Format date string to more readable format (MM/DD)
 * @param {string} dateString - Date string in YYYY-MM-DD format
 * @returns {string} Formatted date
 */
function formatDate(dateString) {
    const date = new Date(dateString);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day}`;
}

// Default route to serve the index.html file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});