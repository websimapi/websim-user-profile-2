// Global variables to store user data
let currentUser = null;
let userProjects = [];
let userFollowers = [];
let userFollowing = [];
let isLoadingMore = false;
let room = null; // Will be initialized with proper error handling
let websocketRetryCount = 0;
const MAX_WEBSOCKET_RETRIES = Infinity; // Unlimited retries for WebSockets as well
const WEBSOCKET_RETRY_SCHEDULE = [15000, 30000, 60000, 120000, 300000]; // Match FETCH_CONFIG's schedule
// Maximum chunk size for WebsimSocket messages (slightly below server limit)
const MAX_CHUNK_SIZE = 25000; // bytes

// HTTP Fetch retry configuration
const FETCH_CONFIG = {
    // Retry schedule in milliseconds: 15s, 30s, 1m, 2m, 5m
    retrySchedule: [
        15 * 1000,  // 15 seconds
        30 * 1000,  // 30 seconds
        60 * 1000,  // 1 minute
        120 * 1000, // 2 minutes
        300 * 1000  // 5 minutes
    ],
    maxDelay: 300 * 1000, // 5 minutes (cap)
    retryStatusCodes: [408, 429, 500, 502, 503, 504] // Status codes to retry
};

// Cache configuration
const CACHE_CONFIG = {
    projectsLocalExpiry: 1000 * 60 * 15, // 15 minutes local cache
    projectsDbExpiry: 1000 * 60 * 60 * 24, // 24 hours DB cache
    followersExpiry: 1000 * 60 * 30, // 30 minutes
    followingExpiry: 1000 * 60 * 30, // 30 minutes
};

// Initialize the app
async function init() {
    try {
        // Initialize WebsimSocket with proper error handling
        await initializeWebsimSocket();
        
        // Get the current user (for this demo we're using the creator)
        const creator = await window.websim.getCreator();
        if (!creator) {
            showError("Could not load user data");
            return;
        }
        
        currentUser = creator;
        
        // Load user profile data
        await loadUserProfile(currentUser.username);
        
        // Set up event listeners
        setupEventListeners();
        
        // Load initial tab content (projects)
        loadProjects();
    } catch (error) {
        console.error("Initialization error:", error);
        showError("Failed to initialize the app: " + error.message);
    }
}

// Fetch wrapper with retry logic for HTTP errors
async function fetchWithRetry(url, options = {}, retryCount = 0) {
    try {
        // Add progress indicator to UI if this is a retry
        if (retryCount > 0) {
            updateFetchStatus(`Retry attempt ${retryCount} for: ${url.split('?')[0]}`);
        }
        
        const response = await fetch(url, options);
        
        // If we get a status code that warrants retry
        if (!response.ok && FETCH_CONFIG.retryStatusCodes.includes(response.status)) {
            // Calculate delay based on retry schedule
            const scheduleIndex = Math.min(retryCount, FETCH_CONFIG.retrySchedule.length - 1);
            const delay = FETCH_CONFIG.retrySchedule[scheduleIndex];
            
            console.warn(`Fetch failed with status ${response.status}. Retrying in ${delay/1000}s...`);
            updateFetchStatus(`Server error (${response.status}). Retrying in ${Math.round(delay/1000)}s...`);
            
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(url, options, retryCount + 1);
        }
        
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        
        // Clear any fetch status indicators on success
        clearFetchStatus();
        return response;
    } catch (error) {
        // Network errors (not HTTP errors) should also be retried
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            // Calculate delay based on retry schedule
            const scheduleIndex = Math.min(retryCount, FETCH_CONFIG.retrySchedule.length - 1);
            const delay = FETCH_CONFIG.retrySchedule[scheduleIndex];
            
            console.warn(`Network error: ${error.message}. Retrying in ${delay/1000}s...`);
            updateFetchStatus(`Network error. Retrying in ${Math.round(delay/1000)}s...`);
            
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(url, options, retryCount + 1);
        }
        
        // Non-retriable error
        clearFetchStatus();
        throw error;
    }
}

// Update fetch status in the UI
function updateFetchStatus(message) {
    // Check if status element exists, create if not
    let statusElement = document.querySelector('.fetch-status');
    if (!statusElement) {
        statusElement = document.createElement('div');
        statusElement.className = 'fetch-status';
        document.querySelector('.container').prepend(statusElement);
    }
    
    statusElement.textContent = message;
    statusElement.style.display = 'block';
}

// Clear fetch status from UI
function clearFetchStatus() {
    const statusElement = document.querySelector('.fetch-status');
    if (statusElement) {
        statusElement.style.display = 'none';
    }
}

// Initialize WebsimSocket with error handling and reconnection logic
async function initializeWebsimSocket() {
    return new Promise((resolve, reject) => {
        try {
            room = new WebsimSocket();
            
            // Handle connection events
            room.onOpen = () => {
                console.log("WebsimSocket connected");
                websocketRetryCount = 0; // Reset retry counter on successful connection
                resolve(room);
            };
            
            room.onError = (error) => {
                console.error("WebsimSocket error:", error);
                handleWebsocketError(error);
            };
            
            room.onClose = (event) => {
                console.warn("WebsimSocket closed:", event?.reason);
                if (event?.reason && event.reason.includes("Message is too large")) {
                    console.warn("Socket closed due to large message size. Using chunking strategy for future requests.");
                }
                
                // Get the appropriate delay based on retry count
                const scheduleIndex = Math.min(websocketRetryCount, WEBSOCKET_RETRY_SCHEDULE.length - 1);
                const delay = WEBSOCKET_RETRY_SCHEDULE[scheduleIndex];
                
                websocketRetryCount++;
                console.log(`Reconnecting WebsimSocket (attempt ${websocketRetryCount}) in ${delay/1000}s...`);
                
                setTimeout(() => {
                    initializeWebsimSocket()
                        .then(() => console.log("WebsimSocket reconnected successfully"))
                        .catch(err => console.error("Failed to reconnect WebsimSocket:", err));
                }, delay);
            };
            
            // Add a custom error handler for various WebSocket errors
            const originalOnMessage = room.socket?.onmessage;
            if (room.socket && originalOnMessage) {
                room.socket.onmessage = function(event) {
                    try {
                        originalOnMessage.call(this, event);
                    } catch (error) {
                        if (error.message && error.message.includes('Cannot enqueue a chunk into a readable stream that is closed')) {
                            console.warn("Caught ReadableStream enqueue error, reconnecting...");
                            room.reconnect();
                        } else {
                            throw error;
                        }
                    }
                };
            }
            
            // Add reconnect method if not already present
            if (!room.reconnect) {
                room.reconnect = function() {
                    try {
                        if (this.socket) {
                            this.socket.close();
                        }
                        // Re-initialize the socket
                        this.connect();
                        console.log("Reconnection initiated");
                    } catch (reconnectError) {
                        console.error("Error during reconnection:", reconnectError);
                    }
                };
            }
            
            // Extend the collection method to handle large messages
            if (room.collection) {
                const originalCollection = room.collection;
                room.collection = function(collectionName) {
                    const collection = originalCollection.call(this, collectionName);
                    
                    // Wrap the create method to handle large data
                    if (collection.create) {
                        const originalCreate = collection.create;
                        collection.create = async function(data) {
                            try {
                                // Preemptively check data size and use chunking if needed
                                const dataSize = JSON.stringify(data).length;
                                if (dataSize > MAX_CHUNK_SIZE * 0.8) { // Use 80% threshold to be safe
                                    console.warn(`Data size (${dataSize} bytes) approaching limit. Using chunking strategy preemptively.`);
                                    return await chunkAndStore(collectionName, data);
                                }
                                return await originalCreate.call(this, data);
                            } catch (error) {
                                if (error.message && error.message.includes('Message is too large') || 
                                    (error.name === 'Error' && error.message && error.message.includes('socket closed'))) {
                                    console.warn("Message too large, using chunking strategy");
                                    return await chunkAndStore(collectionName, data);
                                } else {
                                    throw error;
                                }
                            }
                        };
                    }
                    
                    return collection;
                };
            }
            
            resolve(room);
        } catch (error) {
            console.error("Error initializing WebsimSocket:", error);
            reject(error);
        }
    });
}

// Function to chunk large data and store it in multiple records
async function chunkAndStore(collectionName, data) {
    try {
        console.log("Chunking large data for storage");
        
        // Generate a unique ID for this chunked dataset
        const chunkGroupId = 'chunk_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
        
        // Convert data to string if it's not already
        const dataString = typeof data === 'string' ? data : JSON.stringify(data);
        
        // Calculate number of chunks needed
        const numberOfChunks = Math.ceil(dataString.length / MAX_CHUNK_SIZE);
        console.log(`Splitting data into ${numberOfChunks} chunks`);
        
        // Store metadata first
        await room.collection(`${collectionName}_chunks`).create({
            chunk_group_id: chunkGroupId,
            total_chunks: numberOfChunks,
            is_metadata: true,
            original_type: typeof data,
            timestamp: new Date().toISOString()
        });
        
        // Store each chunk with unlimited retry logic
        for (let i = 0; i < numberOfChunks; i++) {
            const startPos = i * MAX_CHUNK_SIZE;
            const endPos = Math.min((i + 1) * MAX_CHUNK_SIZE, dataString.length);
            const chunkData = dataString.substring(startPos, endPos);
            
            let retryCount = 0;
            let success = false;
            
            while (!success) {
                try {
                    await room.collection(`${collectionName}_chunks`).create({
                        chunk_group_id: chunkGroupId,
                        chunk_index: i,
                        data: chunkData,
                        is_metadata: false
                    });
                    success = true;
                } catch (chunkError) {
                    retryCount++;
                    
                    // Calculate delay based on retry schedule
                    const scheduleIndex = Math.min(retryCount - 1, FETCH_CONFIG.retrySchedule.length - 1);
                    const delay = FETCH_CONFIG.retrySchedule[scheduleIndex];
                    
                    console.warn(`Failed to store chunk ${i} (attempt ${retryCount}). Retrying in ${delay/1000}s:`, chunkError);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        console.log(`Successfully stored ${numberOfChunks} chunks with group ID: ${chunkGroupId}`);
        
        // Return a reference to the chunked data
        return {
            id: chunkGroupId,
            _isChunked: true,
            _collectionName: `${collectionName}_chunks`,
            timestamp: new Date().toISOString()
        };
        
    } catch (error) {
        console.error("Error in chunkAndStore:", error);
        throw error;
    }
}

// Function to retrieve chunked data
async function retrieveChunkedData(collectionName, chunkGroupId) {
    try {
        console.log(`Retrieving chunked data with group ID: ${chunkGroupId}`);
        
        // Get metadata
        const chunks = room.collection(`${collectionName}_chunks`)
            .filter({ chunk_group_id: chunkGroupId })
            .getList();
        
        if (!chunks || chunks.length === 0) {
            throw new Error(`No chunks found for group ID: ${chunkGroupId}`);
        }
        
        // Find metadata chunk
        const metadataChunk = chunks.find(chunk => chunk.is_metadata === true);
        if (!metadataChunk) {
            throw new Error(`Metadata chunk not found for group ID: ${chunkGroupId}`);
        }
        
        const totalChunks = metadataChunk.total_chunks;
        const originalType = metadataChunk.original_type;
        
        // Get all data chunks
        const dataChunks = chunks.filter(chunk => chunk.is_metadata === false);
        
        // Sort chunks by index
        dataChunks.sort((a, b) => a.chunk_index - b.chunk_index);
        
        // Ensure all chunks are present
        if (dataChunks.length !== totalChunks) {
            throw new Error(`Missing chunks: found ${dataChunks.length} of ${totalChunks} expected`);
        }
        
        // Combine chunks
        const combinedData = dataChunks.map(chunk => chunk.data).join('');
        
        // Parse if original was an object
        if (originalType === 'object') {
            return JSON.parse(combinedData);
        }
        
        return combinedData;
        
    } catch (error) {
        console.error("Error retrieving chunked data:", error);
        throw error;
    }
}

// Generic handler for WebSocket errors
function handleWebsocketError(error) {
    if (error.message && error.message.includes('Cannot enqueue a chunk into a readable stream that is closed')) {
        console.warn("ReadableStream is closed, attempting to reconnect");
        if (room && room.reconnect) {
            room.reconnect();
        } else {
            // Fallback if no reconnect method exists
            initializeWebsimSocket()
                .then(() => console.log("WebsimSocket reinitialized successfully"))
                .catch(err => console.error("Failed to reinitialize WebsimSocket:", err));
        }
    } else if (error.message && (error.message.includes('Message is too large') || 
               error.message.includes('socket closed'))) {
        console.warn("Socket error due to message size:", error.message);
        showError("Data transfer error: Message size exceeded limits. Using alternative strategy.");
        // The chunking strategy will be applied in the wrapped collection.create method
    }
}

// Cache Management Functions
// -------------------------

// Check if a cache entry is expired
function isCacheExpired(timestamp, expiryTime) {
    return !timestamp || Date.now() - timestamp > expiryTime;
}

// Save data to localStorage with timestamp
function saveToLocalCache(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify({
            timestamp: Date.now(),
            data: data
        }));
        return true;
    } catch (error) {
        console.warn('Failed to save to localStorage:', error);
        return false;
    }
}

// Get data from localStorage if not expired
function getFromLocalCache(key, expiryTime) {
    try {
        const cached = localStorage.getItem(key);
        if (!cached) return null;
        
        const parsedCache = JSON.parse(cached);
        if (isCacheExpired(parsedCache.timestamp, expiryTime)) {
            localStorage.removeItem(key); // Clean up expired cache
            return null;
        }
        
        return parsedCache.data;
    } catch (error) {
        console.warn('Failed to read from localStorage:', error);
        return null;
    }
}

// Save projects data to database cache with unlimited retry logic and chunking support
async function saveProjectsToDbCache(username, projects, postedFilter, searchQuery) {
    let retryCount = 0;
    
    while (true) {
        try {
            // Check if connection is alive
            if (!room) {
                await initializeWebsimSocket();
            }
            
            // Include postedFilter in the cache key - can be true, false, or null
            const cacheKey = `projects_${postedFilter !== null ? postedFilter : 'all'}_${searchQuery || 'all'}`;
            
            // Check the size of the data to decide if we need chunking
            const dataSize = JSON.stringify(projects).length;
            
            if (dataSize > MAX_CHUNK_SIZE * 0.8) { // Use 80% threshold to be safe
                console.log(`Large cache data detected (${dataSize} bytes), using chunking strategy preemptively`);
                const result = await chunkAndStore('profile_cache', {
                    username: username,
                    cache_key: cacheKey,
                    data: projects,
                    timestamp: new Date().toISOString()
                });
                
                // Store a reference to the chunked data
                await room.collection('profile_cache_references').create({
                    username: username,
                    cache_key: cacheKey,
                    chunk_group_id: result.id,
                    is_chunked: true,
                    timestamp: new Date().toISOString()
                });
                
                return true;
            } else {
                // Regular storage for smaller data
                await room.collection('profile_cache').create({
                    username: username,
                    cache_key: cacheKey,
                    data: projects,
                    timestamp: new Date().toISOString()
                });
                return true;
            }
        } catch (error) {
            retryCount++;
            
            // Calculate delay based on retry schedule
            const scheduleIndex = Math.min(retryCount - 1, FETCH_CONFIG.retrySchedule.length - 1);
            const delay = FETCH_CONFIG.retrySchedule[scheduleIndex];
            
            console.warn(`Failed to save to database cache (attempt ${retryCount}). Retrying in ${delay/1000}s:`, error);
            
            // If it's a socket error, try to reconnect
            if (error.message && (error.message.includes('Cannot enqueue a chunk') || 
                                  error.message.includes('Message is too large') ||
                                  error.message.includes('socket closed'))) {
                handleWebsocketError(error);
            }
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Get projects from database cache with unlimited retry support for chunked data
async function getProjectsFromDbCache(username, postedFilter, searchQuery) {
    let retryCount = 0;
    
    while (true) {
        try {
            // Check if connection is alive
            if (!room) {
                await initializeWebsimSocket();
            }
            
            // Include postedFilter in the cache key - can be true, false, or null
            const cacheKey = `projects_${postedFilter !== null ? postedFilter : 'all'}_${searchQuery || 'all'}`;
            
            // First check if we have a reference to chunked data
            const chunkReferences = room.collection('profile_cache_references')
                .filter({ username: username, cache_key: cacheKey })
                .getList();
                
            if (chunkReferences && chunkReferences.length > 0) {
                // Sort by timestamp to get the most recent
                const sortedRefs = [...chunkReferences].sort((a, b) => 
                    new Date(b.timestamp) - new Date(a.timestamp)
                );
                
                const latestRef = sortedRefs[0];
                const cacheTimestamp = new Date(latestRef.timestamp).getTime();
                
                if (isCacheExpired(cacheTimestamp, CACHE_CONFIG.projectsDbExpiry)) {
                    // Clean up expired cache
                    try {
                        await room.collection('profile_cache_references').delete(latestRef.id);
                    } catch (deleteError) {
                        console.warn('Failed to delete expired chunk reference:', deleteError);
                    }
                    return null;
                }
                
                // Retrieve the chunked data
                return await retrieveChunkedData('profile_cache', latestRef.chunk_group_id);
            }
            
            // If no chunked data, check regular cache
            const cacheEntries = room.collection('profile_cache')
                .filter({ username: username, cache_key: cacheKey })
                .getList();
                
            if (!cacheEntries || cacheEntries.length === 0) return null;
            
            // Sort by timestamp to get the most recent cache entry
            const sortedEntries = [...cacheEntries].sort((a, b) => 
                new Date(b.timestamp) - new Date(a.timestamp)
            );
            
            const latestCache = sortedEntries[0];
            const cacheTimestamp = new Date(latestCache.timestamp).getTime();
            
            if (isCacheExpired(cacheTimestamp, CACHE_CONFIG.projectsDbExpiry)) {
                // Clean up expired cache with error handling
                try {
                    await room.collection('profile_cache').delete(latestCache.id);
                } catch (deleteError) {
                    console.warn('Failed to delete expired cache:', deleteError);
                    // Continue even if deletion fails
                }
                return null;
            }
            
            return latestCache.data;
        } catch (error) {
            retryCount++;
            
            // Calculate delay based on retry schedule
            const scheduleIndex = Math.min(retryCount - 1, FETCH_CONFIG.retrySchedule.length - 1);
            const delay = FETCH_CONFIG.retrySchedule[scheduleIndex];
            
            console.warn(`Failed to read from database cache (attempt ${retryCount}). Retrying in ${delay/1000}s:`, error);
            
            // If it's a socket error, try to reconnect
            if (error.message && (error.message.includes('Cannot enqueue a chunk') || 
                                 error.message.includes('Message is too large') ||
                                 error.message.includes('socket closed'))) {
                handleWebsocketError(error);
            }
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Load user profile data
async function loadUserProfile(username) {
    try {
        // Get user details with retry
        const response = await fetchWithRetry(`/api/v1/users/${username}`);
        const userData = await response.json();
        
        if (!userData.user) {
            throw new Error("User not found");
        }
        
        // Update user details in the UI
        document.getElementById('username').textContent = '@' + userData.user.username;
        document.getElementById('description').textContent = userData.user.description || "No bio provided";
        
        if (userData.user.avatar_url) {
            document.getElementById('avatar').src = userData.user.avatar_url;
        } else {
            document.getElementById('avatar').src = `https://images.websim.com/avatar/${userData.user.username}`;
        }
        
        // Load user stats
        await loadUserStats(username);
        
        // Load followers and following counts
        await loadFollowerCount(username);
        await loadFollowingCount(username);
    } catch (error) {
        console.error("Error loading user profile:", error);
        showError("Failed to load user profile: " + error.message);
    }
}

// Load user statistics with retry
async function loadUserStats(username) {
    try {
        const response = await fetchWithRetry(`/api/v1/users/${username}/stats`);
        const statsData = await response.json();
        
        if (statsData.stats) {
            document.getElementById('total-views').textContent = formatNumber(statsData.stats.total_views);
            document.getElementById('total-likes').textContent = formatNumber(statsData.stats.total_likes);
        }
    } catch (error) {
        console.error("Error loading user stats:", error);
        // Continue despite stats error - don't show a fatal error for this
    }
}

// Load followers count with retry
async function loadFollowerCount(username) {
    try {
        const response = await fetchWithRetry(`/api/v1/users/${username}/followers?count=true`);
        const followersData = await response.json();
        
        if (followersData.followers && followersData.followers.meta) {
            document.getElementById('followers-count').textContent = formatNumber(followersData.followers.meta.count || 0);
        }
    } catch (error) {
        console.error("Error loading followers count:", error);
        // Continue despite followers count error
    }
}

// Load following count with retry
async function loadFollowingCount(username) {
    try {
        const response = await fetchWithRetry(`/api/v1/users/${username}/following?count=true`);
        const followingData = await response.json();
        
        if (followingData.following && followingData.following.meta) {
            document.getElementById('following-count').textContent = formatNumber(followingData.following.meta.count || 0);
        }
    } catch (error) {
        console.error("Error loading following count:", error);
        // Continue despite following count error
    }
}

// Format numbers (e.g., 1000 to 1K)
function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num;
}

// Load projects with improved error handling and retry logic
async function loadProjects() {
    const projectsContainer = document.getElementById('projects-container');
    projectsContainer.innerHTML = '<div class="loading">Loading projects...</div>';
    
    try {
        const postedOnly = document.getElementById('posted-only').checked;
        const searchQuery = document.getElementById('search-input').value.trim();
        
        // Reset projects array
        userProjects = [];
        
        // Create cache keys - properly handle the postedOnly flag
        const postedFilter = postedOnly ? true : null; // null means "all projects" (both posted and unposted)
        const localCacheKey = `projects_${currentUser.username}_${postedFilter !== null ? postedFilter : 'all'}_${searchQuery || 'all'}`;
        
        // Progress indicator
        let progressElement = document.createElement('div');
        progressElement.className = 'loading-progress';
        progressElement.textContent = 'Loading projects...';
        projectsContainer.innerHTML = '';
        projectsContainer.appendChild(progressElement);
        
        // Get cached data (will check later if it's valid)
        const localCachedProjects = getFromLocalCache(localCacheKey, CACHE_CONFIG.projectsLocalExpiry);
        const dbCachedProjects = await getProjectsFromDbCache(currentUser.username, postedFilter, searchQuery);
        
        // First fetch a small batch from API (to compare with cache)
        const initialBatchSize = 10;
        let url = `/api/v1/users/${currentUser.username}/projects?first=${initialBatchSize}`;
        
        // Only add posted=true parameter if postedOnly is true
        if (postedOnly) {
            url += '&posted=true';
        }
        
        if (searchQuery) {
            url += `&query=${encodeURIComponent(searchQuery)}`;
        }
        
        console.log(`Fetching initial batch to validate cache (postedFilter: ${postedFilter})`);
        progressElement.textContent = 'Validating cache...';
        
        // Use fetchWithRetry instead of fetch
        const response = await fetchWithRetry(url);
        const data = await response.json();
        
        if (!data.projects || !data.projects.data) {
            throw new Error("Failed to fetch projects data");
        }
        
        // Get initial projects from API
        const initialProjects = data.projects.data;
        
        // Check if we should use cached data
        let shouldUseCachedData = false;
        let cachedData = null;
        
        // Function to check if cached data is still valid by comparing with initial fetch
        function isCacheValid(cache) {
            if (!cache || cache.length < initialProjects.length) return false;
            
            // Compare first few projects
            for (let i = 0; i < initialProjects.length; i++) {
                const apiProject = initialProjects[i];
                const cachedProject = cache[i];
                
                // Compare project IDs and updated timestamps
                if (!cachedProject || 
                    apiProject.project.id !== cachedProject.project.id || 
                    apiProject.project.updated_at !== cachedProject.project.updated_at) {
                    return false;
                }
            }
            
            return true;
        }
        
        // First check localStorage cache (faster)
        if (localCachedProjects && isCacheValid(localCachedProjects)) {
            console.log("Using valid localStorage cache");
            shouldUseCachedData = true;
            cachedData = localCachedProjects;
            
            // Add cache indicator to show source
            progressElement.classList.add('from-localStorage');
        }
        // Then check database cache
        else if (dbCachedProjects && isCacheValid(dbCachedProjects)) {
            console.log("Using valid database cache");
            shouldUseCachedData = true;
            cachedData = dbCachedProjects;
            
            // Update localStorage for faster access next time
            saveToLocalCache(localCacheKey, dbCachedProjects);
            
            // Add cache indicator to show source
            progressElement.classList.add('from-database');
        }
        
        // If cache is valid, use it
        if (shouldUseCachedData && cachedData) {
            console.log("Cache validated, using cached data");
            userProjects = cachedData;
            renderProjects();
            progressElement.textContent = `Loaded ${userProjects.length} projects from cache`;
            setTimeout(() => progressElement.remove(), 1000);
            return;
        }
        
        // If cache is not valid, fetch all data from API
        console.log("Cache not valid, fetching all data from API");
        userProjects = initialProjects;
        
        // Continue fetching if there are more pages
        let hasNextPage = data.projects.meta.has_next_page;
        let afterCursor = data.projects.meta.end_cursor;
        
        progressElement.textContent = `Loading projects (${userProjects.length})...`;
        progressElement.classList.add('from-api');
        
        // Fetch remaining pages with retry logic
        while (hasNextPage && afterCursor) {
            let pageUrl = `/api/v1/users/${currentUser.username}/projects?first=50`;
            
            if (afterCursor) {
                pageUrl += `&after=${encodeURIComponent(afterCursor)}`;
            }
            
            // Only add posted=true parameter if postedOnly is true
            if (postedOnly) {
                pageUrl += '&posted=true';
            }
            
            if (searchQuery) {
                pageUrl += `&query=${encodeURIComponent(searchQuery)}`;
            }
            
            // Use fetchWithRetry instead of fetch
            const pageResponse = await fetchWithRetry(pageUrl);
            const pageData = await pageResponse.json();
            
            if (!pageData.projects || !pageData.projects.data) {
                break;
            }
            
            // Add new projects to our array
            userProjects = [...userProjects, ...pageData.projects.data];
            
            // Update progress indicator
            progressElement.textContent = `Loading projects (${userProjects.length})...`;
            
            // Check if there are more pages
            hasNextPage = pageData.projects.meta.has_next_page;
            afterCursor = pageData.projects.meta.end_cursor;
        }
        
        // Cache the new results
        saveToLocalCache(localCacheKey, userProjects);
        await saveProjectsToDbCache(currentUser.username, userProjects, postedFilter, searchQuery);
        
        renderProjects();
        progressElement.textContent = `Loaded ${userProjects.length} projects`;
        setTimeout(() => progressElement.remove(), 1000);
        
    } catch (error) {
        console.error("Error loading projects:", error);
        projectsContainer.innerHTML = `
            <div class="error-message">
                <div>Failed to load projects: ${error.message}</div>
                <button class="retry-button" onclick="loadProjects()">Retry Loading Projects</button>
            </div>
        `;
    }
}

// Render projects to the UI
function renderProjects() {
    const projectsContainer = document.getElementById('projects-container');
    
    document.getElementById('projects-count').textContent = userProjects.length;
    
    if (userProjects.length === 0) {
        projectsContainer.innerHTML = '<div class="no-results">No projects found</div>';
        return;
    }
    
    let projectsHTML = '';
    
    userProjects.forEach(projectData => {
        const project = projectData.project;
        const site = projectData.site;
        const stats = project.stats;
        
        const thumbnailUrl = site && site.id ? 
            `https://images.websim.com/v1/site/${site.id}/600` : 
            'https://via.placeholder.com/300x180?text=No+Thumbnail';
        
        projectsHTML += `
            <div class="project-card">
                <img src="${thumbnailUrl}" alt="${project.title || 'Untitled Project'}" class="project-thumbnail">
                <div class="project-details">
                    <h3 class="project-title">${project.title || 'Untitled Project'}</h3>
                    <p class="project-description">${project.description || 'No description provided'}</p>
                    <div class="project-stats">
                        <span>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M15 12C15 13.6569 13.6569 15 12 15C10.3431 15 9 13.6569 9 12C9 10.3431 10.3431 9 12 9C13.6569 9 15 10.3431 15 12Z" stroke="currentColor" stroke-width="2"/>
                                <path d="M2.45825 12C3.73253 7.94288 7.52281 5 12.0004 5C16.4781 5 20.2684 7.94291 21.5426 12C20.2684 16.0571 16.4781 19 12.0005 19C7.52281 19 3.73251 16.0571 2.45825 12Z" stroke="currentColor" stroke-width="2"/>
                            </svg>
                            ${formatNumber(stats.views)}
                        </span>
                        <span>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 5.50063C7.50016 0.825464 2 4.27416 2 9.1371C2 14 6.01943 16.5914 8.96173 18.9109C10 19.7294 11 20.5 12 20.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                <path d="M12 5.50063C16.4998 0.825464 22 4.27416 22 9.1371C22 14 17.9806 16.5914 15.0383 18.9109C14 19.7294 13 20.5 12 20.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            </svg>
                            ${formatNumber(stats.likes)}
                        </span>
                        <span>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 13.4876 3.36093 14.891 4 16.1272L3 21L7.8728 20C9.10904 20.6391 10.5124 21 12 21Z" stroke="currentColor" stroke-width="2"/>
                            </svg>
                            ${formatNumber(stats.comments)}
                        </span>
                        <a href="${site ? `https://websim.com/c/${site.id}` : `https://websim.com/p/${project.id}`}" target="_blank" class="view-link">
                            View
                        </a>
                    </div>
                </div>
            </div>
        `;
    });
    
    projectsContainer.innerHTML = projectsHTML;
    
    // If analytics tab is active, update the analytics data
    if (document.getElementById('analytics').classList.contains('active')) {
        loadAnalytics();
    }
}

// Load followers with improved error handling and retry logic
async function loadFollowers() {
    const followersContainer = document.getElementById('followers-container');
    followersContainer.innerHTML = '<div class="loading">Loading followers...</div>';
    
    try {
        // Reset followers array
        userFollowers = [];
        
        // Create cache key
        const cacheKey = `followers_${currentUser.username}`;
        
        // Progress indicator
        let progressElement = document.createElement('div');
        progressElement.className = 'loading-progress';
        progressElement.textContent = 'Loading followers...';
        followersContainer.innerHTML = '';
        followersContainer.appendChild(progressElement);
        
        // Get cached data
        const cachedFollowers = getFromLocalCache(cacheKey, CACHE_CONFIG.followersExpiry);
        
        // First fetch a small batch from API (to compare with cache)
        const initialBatchSize = 10;
        let url = `/api/v1/users/${currentUser.username}/followers?first=${initialBatchSize}`;
        
        console.log("Fetching initial followers batch to validate cache");
        progressElement.textContent = 'Validating cache...';
        
        // Use fetchWithRetry instead of fetch
        const response = await fetchWithRetry(url);
        const data = await response.json();
        
        if (!data.followers || !data.followers.data) {
            throw new Error("Failed to fetch followers data");
        }
        
        // Get initial followers from API
        const initialFollowers = data.followers.data;
        
        // Check if we should use cached data
        let shouldUseCachedData = false;
        
        // Function to check if cached data is still valid
        function isCacheValid(cache) {
            if (!cache || cache.length < initialFollowers.length) return false;
            
            // Compare first few followers
            for (let i = 0; i < initialFollowers.length; i++) {
                const apiFollower = initialFollowers[i];
                const cachedFollower = cache[i];
                
                if (!cachedFollower || 
                    apiFollower.follow.user.id !== cachedFollower.follow.user.id || 
                    apiFollower.cursor !== cachedFollower.cursor) {
                    return false;
                }
            }
            
            return true;
        }
        
        // Check if cache is valid
        if (cachedFollowers && isCacheValid(cachedFollowers)) {
            console.log("Using valid followers cache");
            userFollowers = cachedFollowers;
            renderFollowers();
            progressElement.textContent = `Loaded ${userFollowers.length} followers from cache`;
            setTimeout(() => progressElement.remove(), 1000);
            return;
        }
        
        // If cache is not valid, fetch all data from API
        console.log("Followers cache not valid, fetching all data from API");
        userFollowers = initialFollowers;
        
        // Continue fetching if there are more pages
        let hasNextPage = data.followers.meta.has_next_page;
        let afterCursor = data.followers.meta.end_cursor;
        
        progressElement.textContent = `Loading followers (${userFollowers.length})...`;
        
        // Fetch remaining pages
        while (hasNextPage && afterCursor) {
            let pageUrl = `/api/v1/users/${currentUser.username}/followers?first=50`;
            
            if (afterCursor) {
                pageUrl += `&after=${encodeURIComponent(afterCursor)}`;
            }
            
            const pageResponse = await fetchWithRetry(pageUrl);
            const pageData = await pageResponse.json();
            
            if (!pageData.followers || !pageData.followers.data) {
                break;
            }
            
            // Add new followers to our array
            userFollowers = [...userFollowers, ...pageData.followers.data];
            
            // Update progress indicator
            progressElement.textContent = `Loading followers (${userFollowers.length})...`;
            
            // Check if there are more pages
            hasNextPage = pageData.followers.meta.has_next_page;
            afterCursor = pageData.followers.meta.end_cursor;
        }
        
        // Cache the new results
        saveToLocalCache(cacheKey, userFollowers);
        
        renderFollowers();
        progressElement.textContent = `Loaded ${userFollowers.length} followers`;
        setTimeout(() => progressElement.remove(), 1000);
        
    } catch (error) {
        console.error("Error loading followers:", error);
        followersContainer.innerHTML = `
            <div class="error-message">
                <div>Failed to load followers: ${error.message}</div>
                <button class="retry-button" onclick="loadFollowers()">Retry Loading Followers</button>
            </div>
        `;
    }
}

// Render followers to the UI
function renderFollowers() {
    const followersContainer = document.getElementById('followers-container');
    
    if (userFollowers.length === 0) {
        followersContainer.innerHTML = '<div class="no-results">No followers found</div>';
        return;
    }
    
    let followersHTML = '';
    
    userFollowers.forEach(followerData => {
        const follower = followerData.follow.user;
        
        const avatarUrl = follower.avatar_url || `https://images.websim.com/avatar/${follower.username}`;
        
        followersHTML += `
            <div class="user-card">
                <img src="${avatarUrl}" alt="${follower.username}">
                <div class="user-card-details">
                    <h3><a href="https://websim.com/@${follower.username}" target="_blank">@${follower.username}</a></h3>
                    <p>${follower.description || 'No bio provided'}</p>
                </div>
            </div>
        `;
    });
    
    followersContainer.innerHTML = followersHTML;
}

// Load following with improved error handling and retry logic
async function loadFollowing() {
    const followingContainer = document.getElementById('following-container');
    followingContainer.innerHTML = '<div class="loading">Loading following...</div>';
    
    try {
        // Reset following array
        userFollowing = [];
        
        // Create cache key
        const cacheKey = `following_${currentUser.username}`;
        
        // Progress indicator
        let progressElement = document.createElement('div');
        progressElement.className = 'loading-progress';
        progressElement.textContent = 'Loading following...';
        followingContainer.innerHTML = '';
        followingContainer.appendChild(progressElement);
        
        // Get cached data
        const cachedFollowing = getFromLocalCache(cacheKey, CACHE_CONFIG.followingExpiry);
        
        // First fetch a small batch from API (to compare with cache)
        const initialBatchSize = 10;
        let url = `/api/v1/users/${currentUser.username}/following?first=${initialBatchSize}`;
        
        console.log("Fetching initial following batch to validate cache");
        progressElement.textContent = 'Validating cache...';
        
        // Use fetchWithRetry instead of fetch
        const response = await fetchWithRetry(url);
        const data = await response.json();
        
        if (!data.following || !data.following.data) {
            throw new Error("Failed to fetch following data");
        }
        
        // Get initial following from API
        const initialFollowing = data.following.data;
        
        // Check if we should use cached data
        let shouldUseCachedData = false;
        
        // Function to check if cached data is still valid
        function isCacheValid(cache) {
            if (!cache || cache.length < initialFollowing.length) return false;
            
            // Compare first few following
            for (let i = 0; i < initialFollowing.length; i++) {
                const apiFollowing = initialFollowing[i];
                const cachedFollowing = cache[i];
                
                if (!cachedFollowing || 
                    apiFollowing.follow.user.id !== cachedFollowing.follow.user.id || 
                    apiFollowing.cursor !== cachedFollowing.cursor) {
                    return false;
                }
            }
            
            return true;
        }
        
        // Check if cache is valid
        if (cachedFollowing && isCacheValid(cachedFollowing)) {
            console.log("Using valid following cache");
            userFollowing = cachedFollowing;
            renderFollowing();
            progressElement.textContent = `Loaded ${userFollowing.length} following from cache`;
            setTimeout(() => progressElement.remove(), 1000);
            return;
        }
        
        // If cache is not valid, fetch all data from API
        console.log("Following cache not valid, fetching all data from API");
        userFollowing = initialFollowing;
        
        // Continue fetching if there are more pages
        let hasNextPage = data.following.meta.has_next_page;
        let afterCursor = data.following.meta.end_cursor;
        
        progressElement.textContent = `Loading following (${userFollowing.length})...`;
        
        // Fetch remaining pages
        while (hasNextPage && afterCursor) {
            let pageUrl = `/api/v1/users/${currentUser.username}/following?first=50`;
            
            if (afterCursor) {
                pageUrl += `&after=${encodeURIComponent(afterCursor)}`;
            }
            
            const pageResponse = await fetchWithRetry(pageUrl);
            const pageData = await pageResponse.json();
            
            if (!pageData.following || !pageData.following.data) {
                break;
            }
            
            // Add new following to our array
            userFollowing = [...userFollowing, ...pageData.following.data];
            
            // Update progress indicator
            progressElement.textContent = `Loading following (${userFollowing.length})...`;
            
            // Check if there are more pages
            hasNextPage = pageData.following.meta.has_next_page;
            afterCursor = pageData.following.meta.end_cursor;
        }
        
        // Cache the new results
        saveToLocalCache(cacheKey, userFollowing);
        
        renderFollowing();
        progressElement.textContent = `Loaded ${userFollowing.length} following`;
        setTimeout(() => progressElement.remove(), 1000);
        
    } catch (error) {
        console.error("Error loading following:", error);
        followingContainer.innerHTML = `
            <div class="error-message">
                <div>Failed to load following: ${error.message}</div>
                <button class="retry-button" onclick="loadFollowing()">Retry Loading Following</button>
            </div>
        `;
    }
}

// Render following to the UI
function renderFollowing() {
    const followingContainer = document.getElementById('following-container');
    
    if (userFollowing.length === 0) {
        followingContainer.innerHTML = '<div class="no-results">Not following anyone</div>';
        return;
    }
    
    let followingHTML = '';
    
    userFollowing.forEach(followingData => {
        const following = followingData.follow.user;
        
        const avatarUrl = following.avatar_url || `https://images.websim.com/avatar/${following.username}`;
        
        followingHTML += `
            <div class="user-card">
                <img src="${avatarUrl}" alt="${following.username}">
                <div class="user-card-details">
                    <h3><a href="https://websim.com/@${following.username}" target="_blank">@${following.username}</a></h3>
                    <p>${following.description || 'No bio provided'}</p>
                </div>
            </div>
        `;
    });
    
    followingContainer.innerHTML = followingHTML;
}

// Load analytics with cache support
async function loadAnalytics() {
    const topProjectsElement = document.getElementById('top-projects');
    topProjectsElement.innerHTML = '<div class="loading">Loading analytics...</div>';
    
    try {
        // Use projects we've already loaded
        if (userProjects.length === 0) {
            await loadProjects();
        }
        
        // Sort projects by views
        const sortedProjects = [...userProjects].sort((a, b) => 
            b.project.stats.views - a.project.stats.views
        );
        
        // Show top 10 projects
        const topProjects = sortedProjects.slice(0, 10);
        
        let topProjectsHTML = '';
        topProjects.forEach(projectData => {
            const project = projectData.project;
            
            topProjectsHTML += `
                <div class="project-row">
                    <div class="project-name">${project.title || 'Untitled Project'}</div>
                    <div class="project-views">${formatNumber(project.stats.views)} views</div>
                </div>
            `;
        });
        
        if (topProjectsHTML === '') {
            topProjectsHTML = '<div class="no-results">No projects data available</div>';
        }
        
        topProjectsElement.innerHTML = topProjectsHTML;
        
        // Create views chart with random data (since we don't have historical data)
        createViewsChart();
    } catch (error) {
        console.error("Error loading analytics:", error);
        topProjectsElement.innerHTML = '<div class="error">Failed to load analytics</div>';
    }
}

// Create a views chart with sample data
function createViewsChart() {
    const ctx = document.getElementById('views-chart').getContext('2d');
    
    // Generate sample data (last 7 days)
    const labels = [];
    const data = [];
    
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        labels.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        
        // Random value between 100 and 1000
        data.push(Math.floor(Math.random() * 900) + 100);
    }
    
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Views',
                data: data,
                fill: true,
                backgroundColor: 'rgba(58, 134, 255, 0.2)',
                borderColor: 'rgba(58, 134, 255, 1)',
                tension: 0.4,
                pointBackgroundColor: 'rgba(58, 134, 255, 1)',
                pointBorderColor: '#fff',
                pointRadius: 4,
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.05)'
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// Set up event listeners
function setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(button => {
        button.addEventListener('click', () => {
            const tabId = button.getAttribute('data-tab');
            
            // Update active button
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            button.classList.add('active');
            
            // Update active tab content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById(tabId).classList.add('active');
            
            // Load content based on tab
            if (tabId === 'projects') {
                loadProjects();
            } else if (tabId === 'followers') {
                loadFollowers();
            } else if (tabId === 'following') {
                loadFollowing();
            } else if (tabId === 'analytics') {
                loadAnalytics();
            }
        });
    });
    
    // Search input
    const searchInput = document.getElementById('search-input');
    let debounceTimeout;
    
    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => {
            loadProjects();
        }, 300);
    });
    
    // Posted only checkbox
    document.getElementById('posted-only').addEventListener('change', () => {
        loadProjects();
    });
    
    // Add a cache clear button for testing
    const profileHeader = document.querySelector('.profile-header');
    const clearCacheBtn = document.createElement('button');
    clearCacheBtn.textContent = 'Clear Cache';
    clearCacheBtn.className = 'clear-cache-btn';
    clearCacheBtn.addEventListener('click', clearAllCaches);
    profileHeader.appendChild(clearCacheBtn);
}

// Clear all caches with improved error handling for large messages
async function clearAllCaches() {
    try {
        // Clear localStorage caches
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('projects_') || key.startsWith('followers_') || key.startsWith('following_')) {
                keysToRemove.push(key);
            }
        }
        
        keysToRemove.forEach(key => localStorage.removeItem(key));
        
        // Clear database caches for this user with unlimited retry logic
        let retryCount = 0;
        let success = false;
        
        // Check if WebsimSocket is initialized
        if (!room) {
            await initializeWebsimSocket();
        }
        
        while (!success) {
            try {
                // Clear regular cache entries
                const cacheEntries = room.collection('profile_cache')
                    .filter({ username: currentUser.username })
                    .getList();
                    
                for (const entry of cacheEntries) {
                    await room.collection('profile_cache').delete(entry.id);
                }
                
                // Clear chunked cache references
                const chunkReferences = room.collection('profile_cache_references')
                    .filter({ username: currentUser.username })
                    .getList();
                    
                for (const ref of chunkReferences) {
                    // Delete the reference
                    await room.collection('profile_cache_references').delete(ref.id);
                    
                    // Get and delete all associated chunks
                    const chunks = room.collection('profile_cache_chunks')
                        .filter({ chunk_group_id: ref.chunk_group_id })
                        .getList();
                        
                    for (const chunk of chunks) {
                        await room.collection('profile_cache_chunks').delete(chunk.id);
                    }
                }
                
                success = true;
            } catch (error) {
                retryCount++;
                
                // Calculate delay based on retry schedule
                const scheduleIndex = Math.min(retryCount - 1, FETCH_CONFIG.retrySchedule.length - 1);
                const delay = FETCH_CONFIG.retrySchedule[scheduleIndex];
                
                console.warn(`Failed to clear database caches (attempt ${retryCount}). Retrying in ${delay/1000}s:`, error);
                
                // If it's a socket error, try to reconnect
                if (error.message && (error.message.includes('Cannot enqueue a chunk') || 
                                     error.message.includes('Message is too large') ||
                                     error.message.includes('socket closed'))) {
                    handleWebsocketError(error);
                }
                
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        alert('All caches cleared!');
        
        // Reload current tab
        const activeTab = document.querySelector('.tab-btn.active').getAttribute('data-tab');
        if (activeTab === 'projects') {
            loadProjects();
        } else if (activeTab === 'followers') {
            loadFollowers();
        } else if (activeTab === 'following') {
            loadFollowing();
        } else if (activeTab === 'analytics') {
            loadAnalytics();
        }
    } catch (error) {
        console.error('Error clearing caches:', error);
        showError('Failed to clear some caches: ' + error.message);
    }
}

// Show error message with improved detail and retry options
function showError(message) {
    console.error("ERROR:", message);
    
    const container = document.querySelector('.container');
    const existingError = container.querySelector('.error-message');
    if (existingError) {
        existingError.remove(); // Remove existing error before showing new one
    }
    
    const errorElement = document.createElement('div');
    errorElement.className = 'error-message';
    
    // Add specific help text for different error types
    if (message.includes('Message is too large') || message.includes('socket closed') || message.includes('Message size exceeded')) {
        errorElement.innerHTML = `
            <div>
                <strong>Data size error:</strong> The system is handling a large amount of data. 
                Using a chunking strategy to work around this limitation.
            </div>
        `;
    } else if (message.includes('500')) {
        errorElement.innerHTML = `
            <div>
                <strong>Server error (500):</strong> The server encountered an internal error.
                This is often temporary. We'll automatically retry the request.
            </div>
        `;
    } else if (message.includes('502') || message.includes('503') || message.includes('504')) {
        errorElement.innerHTML = `
            <div>
                <strong>Server unavailable:</strong> The server is temporarily unavailable.
                This is often due to maintenance or high load. We'll automatically retry.
            </div>
        `;
    } else if (message.includes('429')) {
        errorElement.innerHTML = `
            <div>
                <strong>Too many requests:</strong> We've sent too many requests to the server.
                Taking a brief pause before retrying.
            </div>
        `;
    } else if (message.includes('fetch') || message.includes('network')) {
        errorElement.innerHTML = `
            <div>
                <strong>Network error:</strong> There was a problem connecting to the server.
                Please check your internet connection. We'll automatically retry.
            </div>
        `;
    } else {
        errorElement.textContent = message;
    }
    
    // Add retry button for connection errors and server errors
    if (message.includes('connection') || message.includes('network') || message.includes('WebSocket') || 
        message.includes('Message is too large') || message.includes('socket closed') ||
        message.includes('500') || message.includes('502') || message.includes('503') || 
        message.includes('504') || message.includes('429')) {
        
        const retryButton = document.createElement('button');
        retryButton.textContent = 'Retry Connection';
        retryButton.className = 'retry-button';
        retryButton.addEventListener('click', async () => {
            errorElement.textContent = 'Reconnecting...';
            try {
                // If it's a WebSocket issue
                if (message.includes('WebSocket') || message.includes('socket closed')) {
                    await initializeWebsimSocket();
                }
                
                // Reload current tab
                const activeTab = document.querySelector('.tab-btn.active').getAttribute('data-tab');
                if (activeTab === 'projects') {
                    loadProjects();
                } else if (activeTab === 'followers') {
                    loadFollowers();
                } else if (activeTab === 'following') {
                    loadFollowing();
                } else if (activeTab === 'analytics') {
                    loadAnalytics();
                }
                
                errorElement.remove();
            } catch (error) {
                errorElement.textContent = 'Reconnection failed: ' + error.message;
            }
        });
        errorElement.appendChild(retryButton);
    }
    
    container.prepend(errorElement);
    
    // Remove error after a while (except for critical errors)
    if (!message.includes('Failed to initialize')) {
        setTimeout(() => {
            errorElement.remove();
        }, 10000); // Show error for 10 seconds
    }
}

// Initialize the app when page loads
window.addEventListener('DOMContentLoaded', init);