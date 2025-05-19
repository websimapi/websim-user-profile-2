// Global variables to store user data
let currentUser = null;
let userProjects = [];
let userFollowers = [];
let userFollowing = [];
let isLoadingMore = false;

// Initialize the app
async function init() {
    try {
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
        showError("Failed to initialize the app");
    }
}

// Load user profile data
async function loadUserProfile(username) {
    try {
        // Get user details
        const response = await fetch(`/api/v1/users/${username}`);
        const userData = await response.json();
        
        if (!userData.user) {
            showError("User not found");
            return;
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
        showError("Failed to load user profile");
    }
}

// Load user statistics
async function loadUserStats(username) {
    try {
        const response = await fetch(`/api/v1/users/${username}/stats`);
        const statsData = await response.json();
        
        if (statsData.stats) {
            document.getElementById('total-views').textContent = formatNumber(statsData.stats.total_views);
            document.getElementById('total-likes').textContent = formatNumber(statsData.stats.total_likes);
        }
    } catch (error) {
        console.error("Error loading user stats:", error);
    }
}

// Load followers count
async function loadFollowerCount(username) {
    try {
        const response = await fetch(`/api/v1/users/${username}/followers?count=true`);
        const followersData = await response.json();
        
        if (followersData.followers && followersData.followers.meta) {
            document.getElementById('followers-count').textContent = formatNumber(followersData.followers.meta.count || 0);
        }
    } catch (error) {
        console.error("Error loading followers count:", error);
    }
}

// Load following count
async function loadFollowingCount(username) {
    try {
        const response = await fetch(`/api/v1/users/${username}/following?count=true`);
        const followingData = await response.json();
        
        if (followingData.following && followingData.following.meta) {
            document.getElementById('following-count').textContent = formatNumber(followingData.following.meta.count || 0);
        }
    } catch (error) {
        console.error("Error loading following count:", error);
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

// Load projects with pagination to get ALL projects
async function loadProjects() {
    const projectsContainer = document.getElementById('projects-container');
    projectsContainer.innerHTML = '<div class="loading">Loading projects...</div>';
    
    try {
        const postedOnly = document.getElementById('posted-only').checked;
        const searchQuery = document.getElementById('search-input').value.trim();
        
        // Reset projects array
        userProjects = [];
        
        // Fetch all projects using pagination
        await fetchAllProjects(postedOnly, searchQuery);
        
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
    } catch (error) {
        console.error("Error loading projects:", error);
        projectsContainer.innerHTML = '<div class="error">Failed to load projects</div>';
    }
}

// Fetch all projects using pagination
async function fetchAllProjects(postedOnly, searchQuery) {
    let hasNextPage = true;
    let afterCursor = null;
    const limit = 50; // Fetch in batches of 50 for efficiency
    
    const projectsContainer = document.getElementById('projects-container');
    let progressElement = document.createElement('div');
    progressElement.className = 'loading-progress';
    progressElement.textContent = 'Loading projects (0)...';
    projectsContainer.innerHTML = '';
    projectsContainer.appendChild(progressElement);
    
    while (hasNextPage) {
        let url = `/api/v1/users/${currentUser.username}/projects?first=${limit}`;
        
        if (afterCursor) {
            url += `&after=${encodeURIComponent(afterCursor)}`;
        }
        
        if (postedOnly) {
            url += '&posted=true';
        }
        
        if (searchQuery) {
            url += `&query=${encodeURIComponent(searchQuery)}`;
        }
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.projects || !data.projects.data) {
            break;
        }
        
        // Add new projects to our array
        userProjects = [...userProjects, ...data.projects.data];
        
        // Update progress indicator
        progressElement.textContent = `Loading projects (${userProjects.length})...`;
        
        // Check if there are more pages
        hasNextPage = data.projects.meta.has_next_page;
        afterCursor = data.projects.meta.end_cursor;
        
        // If no more pages or no cursor, break the loop
        if (!hasNextPage || !afterCursor) {
            break;
        }
    }
}

// Load followers
async function loadFollowers() {
    const followersContainer = document.getElementById('followers-container');
    followersContainer.innerHTML = '<div class="loading">Loading followers...</div>';
    
    try {
        // Reset followers array
        userFollowers = [];
        
        // Fetch all followers using pagination
        await fetchAllFollowers();
        
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
    } catch (error) {
        console.error("Error loading followers:", error);
        followersContainer.innerHTML = '<div class="error">Failed to load followers</div>';
    }
}

// Fetch all followers using pagination
async function fetchAllFollowers() {
    let hasNextPage = true;
    let afterCursor = null;
    const limit = 50; // Fetch in batches of 50
    
    const followersContainer = document.getElementById('followers-container');
    let progressElement = document.createElement('div');
    progressElement.className = 'loading-progress';
    progressElement.textContent = 'Loading followers (0)...';
    followersContainer.innerHTML = '';
    followersContainer.appendChild(progressElement);
    
    while (hasNextPage) {
        let url = `/api/v1/users/${currentUser.username}/followers?first=${limit}`;
        
        if (afterCursor) {
            url += `&after=${encodeURIComponent(afterCursor)}`;
        }
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.followers || !data.followers.data) {
            break;
        }
        
        // Add new followers to our array
        userFollowers = [...userFollowers, ...data.followers.data];
        
        // Update progress indicator
        progressElement.textContent = `Loading followers (${userFollowers.length})...`;
        
        // Check if there are more pages
        hasNextPage = data.followers.meta.has_next_page;
        afterCursor = data.followers.meta.end_cursor;
        
        // If no more pages or no cursor, break the loop
        if (!hasNextPage || !afterCursor) {
            break;
        }
    }
}

// Load following with pagination
async function loadFollowing() {
    const followingContainer = document.getElementById('following-container');
    followingContainer.innerHTML = '<div class="loading">Loading following...</div>';
    
    try {
        // Reset following array
        userFollowing = [];
        
        // Fetch all following using pagination
        await fetchAllFollowing();
        
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
    } catch (error) {
        console.error("Error loading following:", error);
        followingContainer.innerHTML = '<div class="error">Failed to load following</div>';
    }
}

// Fetch all following using pagination
async function fetchAllFollowing() {
    let hasNextPage = true;
    let afterCursor = null;
    const limit = 50; // Fetch in batches of 50
    
    const followingContainer = document.getElementById('following-container');
    let progressElement = document.createElement('div');
    progressElement.className = 'loading-progress';
    progressElement.textContent = 'Loading following (0)...';
    followingContainer.innerHTML = '';
    followingContainer.appendChild(progressElement);
    
    while (hasNextPage) {
        let url = `/api/v1/users/${currentUser.username}/following?first=${limit}`;
        
        if (afterCursor) {
            url += `&after=${encodeURIComponent(afterCursor)}`;
        }
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.following || !data.following.data) {
            break;
        }
        
        // Add new following to our array
        userFollowing = [...userFollowing, ...data.following.data];
        
        // Update progress indicator
        progressElement.textContent = `Loading following (${userFollowing.length})...`;
        
        // Check if there are more pages
        hasNextPage = data.following.meta.has_next_page;
        afterCursor = data.following.meta.end_cursor;
        
        // If no more pages or no cursor, break the loop
        if (!hasNextPage || !afterCursor) {
            break;
        }
    }
}

// Load analytics data and render charts
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
}

// Show error message
function showError(message) {
    const container = document.querySelector('.container');
    const errorElement = document.createElement('div');
    errorElement.className = 'error-message';
    errorElement.textContent = message;
    container.prepend(errorElement);
    
    setTimeout(() => {
        errorElement.remove();
    }, 5000);
}

// Initialize the app when page loads
window.addEventListener('DOMContentLoaded', init);