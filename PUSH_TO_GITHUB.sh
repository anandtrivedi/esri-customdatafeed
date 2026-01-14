#!/bin/bash
# Quick script to push to GitHub
# Usage: ./PUSH_TO_GITHUB.sh YOUR_GITHUB_USERNAME

if [ -z "$1" ]; then
    echo "Usage: ./PUSH_TO_GITHUB.sh YOUR_GITHUB_USERNAME"
    echo ""
    echo "Example: ./PUSH_TO_GITHUB.sh johndoe"
    echo ""
    echo "This will:"
    echo "  1. Add remote: https://github.com/$1/esri-customdatafeed.git"
    echo "  2. Push to GitHub"
    echo ""
    echo "Make sure you've created the repository on GitHub first!"
    echo "Go to: https://github.com/new"
    exit 1
fi

USERNAME=$1
REPO_URL="https://github.com/$USERNAME/esri-customdatafeed.git"

echo "================================================"
echo "Pushing to GitHub"
echo "================================================"
echo ""
echo "Repository: $REPO_URL"
echo "Branch: main"
echo "Commit: 870a482"
echo ""
echo "Make sure you've created the repository on GitHub:"
echo "https://github.com/$USERNAME/esri-customdatafeed"
echo ""
read -p "Press Enter to continue, or Ctrl+C to cancel..."
echo ""

# Add remote
echo "Adding remote..."
git remote add origin "$REPO_URL" 2>&1 || echo "Remote already exists"

# Show remote
echo ""
echo "Remote configured:"
git remote -v

# Push
echo ""
echo "Pushing to GitHub..."
git push -u origin main

echo ""
echo "================================================"
echo "Done!"
echo "================================================"
echo ""
echo "Your repository is now at:"
echo "https://github.com/$USERNAME/esri-customdatafeed"
echo ""
echo "Next steps:"
echo "  1. Add repository topics"
echo "  2. Add description"
echo "  3. Enable discussions (optional)"
echo "  4. Share with community!"
