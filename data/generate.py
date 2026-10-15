#!/usr/bin/env python3
"""
Generate JSON content similar to a reference file using Claude API.

Usage: python generate_json.py <topic>
"""

import json
import sys
import os
import re
import requests
import time
from urllib.parse import quote
from anthropic import Anthropic
from openai import OpenAI



MAX_TOKENS = 20000
MIN_NODES = 30
MAX_NODES = 60
JSON_MODEL = "claude-opus-4-1-20250805"  # claude-sonnet-4-5-20250929
WEB_MODEL = "claude-opus-4-1-20250805"
PEXELS_API_URL = "https://api.pexels.com/v1/search"
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")


def load_reference_file(filepath="knowledge.json"):
    """Load and return the reference JSON file."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"Error: Reference file '{filepath}' not found.")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in reference file: {e}")
        sys.exit(1)


def fix_json_content(content, api_key):
    """ Use Claude API to fix malformed JSON content. """

    prompt = """
        The following content is intended to be a JSON file, but it may have formatting issues. 
        Please correct any errors and return valid JSON only, without any explanations or markdown code blocks.
        Here is the content:
        ```json
        {content}
        ```
        """
    client = Anthropic(api_key=api_key)

    try:
        # Send request to Claude
        response = client.messages.create(
                model=JSON_MODEL,  # You can change this to other models
                max_tokens=MAX_TOKENS,
                temperature=0.7,
                messages=[
                    {
                        "role": "user",
                        "content": prompt
                    }
                ]
            )
        
        # Extract the generated content
        generated_content = response.content[0].text
            
        # Clean up the response if it has markdown code blocks
        if "```json" in generated_content:
            generated_content = generated_content.split("```json")[1].split("```")[0]
        elif "```" in generated_content:
            generated_content = generated_content.split("```")[1].split("```")[0]
        
        # Parse to validate JSON
        generated_json = json.loads(generated_content.strip())
        return generated_json

    except json.JSONDecodeError as e:
            print(f"Error: Generated content is not valid JSON: {e}")
            print("Attempting to fix content:")
            fix_json_content(generated_content, api_key)
    except Exception as e:
            print(f"Error calling Claude API: {e}")
            sys.exit(1)


def generate_similar_json(topic, reference_json, api_key, source_text="", source_only=False):
    """Use Claude API to generate similar JSON content for the given topic."""
    
    # Initialize the Anthropic client
    client = Anthropic(api_key=api_key)
    
    # Prepare the prompt
    prompt = f"""Based on the following reference JSON structure and content style, create a similar JSON file for the topic: "{topic}"

Reference JSON:
```json
{json.dumps(reference_json, indent=2)}
```

Please generate a JSON file with:
1. Similar structure and field types as the reference. In particular, a tree-structure growing from a single root node with branches of various depths.
    a. Each node has a 'weight' between 1 and 100 that speaks to its relative importance, e.g. major nodes typically have 100<weight>50, while minor caveats are 20 or less.
    b. Each node will also have some 'widgets' (between 1 and 8) that give more detail on the node; the widget name could be either a local image file or link to a youtube video relevant to that node. 
    c. Widgets also have a title, subtitle, and notes fields which you should fill with whatever details are relevant and informative (max 200 chars there).
    d. The "prose" field exists on each node and widget and would be what you would typically say to explain it in a real live talk. 
    e. Also insert a "url" field for each widget which is either relevant to or a source for the prose.
2. Content relevant to the topic: "{topic}", with source reference material taken from the following text: {source_text}. If source_only is True, only use information from the source text. source_only = {source_only}.
3. Similar depth and detail level as the reference, i.e. between {MIN_NODES} and {MAX_NODES} nodes with a good variety of widgets.
4. Properly formatted valid JSON

Return ONLY the JSON content, no explanations or markdown code blocks."""

    try:
        # Send request to Claude
        response = client.messages.create(
            model=JSON_MODEL,  # You can change this to other models
            max_tokens=MAX_TOKENS,
            temperature=0.7,
            messages=[
                {
                    "role": "user",
                    "content": prompt
                }
            ]
        )
        
        # Extract the generated content
        generated_content = response.content[0].text
        
        # Clean up the response if it has markdown code blocks
        if "```json" in generated_content:
            generated_content = generated_content.split("```json")[1].split("```")[0]
        elif "```" in generated_content:
            generated_content = generated_content.split("```")[1].split("```")[0]
        
        # Parse to validate JSON
        generated_json = json.loads(generated_content.strip())
        return generated_json
        
    except json.JSONDecodeError as e:
        print(f"Error: Generated content is not valid JSON: {e}")
        print("Attempting to fix content:")
        fix_json_content(generated_content, api_key)
    except Exception as e:
        print(f"Error calling Claude API: {e}")
        sys.exit(1)

def save_output_file(data, filepath="out.json"):
    """Save the generated JSON to the output file."""
    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"Successfully generated and saved JSON to '{filepath}'")
    except Exception as e:
        print(f"Error saving output file: {e}")
        sys.exit(1)

def is_youtube_link_broken(url: str) -> bool:
    """
    Checks the status of a YouTube video link and returns a boolean result.

    It returns True if the link is broken (due to network error, HTTP status, 
    or page content indicating unavailability). Returns False otherwise.

    Args:
        url (str): The full YouTube URL to check.

    Returns:
        bool: True if the video is broken/unavailable, False otherwise.
    """
    # 1. Check if it's a valid YouTube URL format (optional but good practice)
    if 'youtube.com' not in url and 'youtu.be' not in url:
        print("Invalid URL format: This does not appear to be a YouTube link.")
        return True # Considered broken if format is wrong

    print(f"Checking URL: {url}")
    
    # 2. Fetch the webpage content
    try:
        # Use a short timeout and headers to simulate a real browser request
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        response = requests.get(url, headers=headers, timeout=10)
        
        # 3. Check for obvious HTTP errors (404 Not Found, 500 Server Error, etc.)
        if response.status_code >= 400:
            print(f"HTTP Error {response.status_code}: The page could not be reached.")
            return True # Broken due to HTTP error

    except requests.exceptions.RequestException as e:
        print(f"Network or Connection Error: {e}")
        return True # Broken due to connection error

    # 4. Analyze HTML content for unavailability indicators (Status Code 200)
    
    # Common text indicators of broken/unavailable content on YouTube's 200 response pages
    unavailability_indicators = [
        "This video is unavailable",  # General unavailable
        "This video has been removed",
        "Video unavailable",
        "404 Not Found",
        "The video is private",      # Private video
        "Restricted content",        # Age or other restriction
        "Not available in your country",
        # Pattern matching for YouTube's specific error page structure
        r'content=\"404\"',
    ]

    html_content = response.text
    
    for indicator in unavailability_indicators:
        if re.search(indicator, html_content, re.IGNORECASE):
            print(f"Broken Link Detected via content analysis (Indicator: {indicator.splitlines()[0][:20]}...)")
            return True # Broken due to content indicator

    # 5. If no errors were found
    return False

def get_image_url(query_string, pexels_key = os.environ.get("PEXELS_API_KEY")) -> str:
    """
    Searches Pexels for a given query string and returns the large image URL
    of the first matching photo.

    Args:
        query_string: The text to search for (e.g., "gold mining").

    Returns:
        The URL of the large image (str), or None if an error occurs or no image is found.
    """
    if not query_string:
        print("Error: Search query cannot be empty.", file=sys.stderr)
        return None

    params = {
        "query": query_string,
        "per_page": 3,
    }

    headers = {
        "Authorization": pexels_key,
    }

    try:
        print(f"Searching Pexels for: '{query_string}'...")
        time.sleep(1)  # To avoid hitting rate limits
        response = requests.get(PEXELS_API_URL, params=params, headers=headers)
        response.raise_for_status()

        data = response.json()

        if data and data.get("photos") and len(data["photos"]) > 0:
            first_photo = data["photos"][0]
            image_url = first_photo.get("src", {}).get("large")

            if image_url:
                print("Image URL found successfully.")
                return image_url
            else:
                print("Error: 'src.large' field missing in the first photo.", file=sys.stderr)
                return None
        else:
            print(f"No images found for the query: '{query_string}'", file=sys.stderr)
            return None

    except requests.exceptions.HTTPError as e:
        print(f"HTTP Error occurred: {e}", file=sys.stderr)
    except requests.exceptions.RequestException as e:
        print(f"Network or connection error: {e}", file=sys.stderr)
    except Exception as e:
        print(f"An unexpected error occurred: {e}", file=sys.stderr)

    return None

def find_youtube_link_scrape(topic: str) -> str:
    """
    Finds a working YouTube link for the given topic by scraping YouTube search results.
    (No API key required.)
    """
    query = quote(topic)
    url = f"https://www.youtube.com/results?search_query={query}"
    
    response = requests.get(url)
    if response.status_code != 200:
        print("Failed to retrieve search results.")
        return None

    # Find first video ID in HTML
    matches = re.findall(r'"videoId":"(.*?)"', response.text)
    if not matches:
        return None
    
    video_id = matches[0]
    return f"https://www.youtube.com/watch?v={video_id}"


def get_working_youtube_link_from_query(topic: str, model="gpt-4.1"):
    """
    Uses a ChatGPT model to find a working YouTube video link for the given topic.
    This relies on models with web access (like gpt-4.1 or gpt-5).
    """
    client = OpenAI()
    
    prompt = f"""
    Find a working YouTube video link related to the following topic:
    "{topic}"

    The link must lead to a valid, publicly viewable video on youtube.com.
    Return only the URL.
    """
    
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}]
    )
    
    return response.choices[0].message.content.strip()

def media_insert(topic_json, topic_file, pexels_key):
    """
    Here we open the JSON topic file, and for each widget, we find relevant images/videos: if the widget name is an image file extension, we search for an image which 
    we download from Google Images and save locally with the same name; if it's a video file extension, we check the YouTube link is valid, or we search YouTube for a relevant video and replace the link.
    """
 
    def process_node(node):
        # Process widgets
        for widget in node.get('widgets', []):
            widget_name = widget.get('name', '')
            if widget_name is None:
                widget_name = ''
            if widget_name.lower().endswith(('.png', '.jpg', '.jpeg', '.gif')):
                # Image file - search and download image
                print(f"Searching for image for widget: {widget_name}")
                widget_base_name = os.path.splitext(os.path.basename(widget_name))[0].replace('_', ' ').replace('-', ' ')
                widget['name'] = get_image_url(widget_base_name, pexels_key)
            elif "youtube.com" in widget_name:
                if is_youtube_link_broken(widget_name):
                    new_name = find_youtube_link_scrape(widget["prose"])
                    if new_name is not None:
                        widget['name'] = new_name
                continue
        
        # Recursively process child nodes
        for child in node.get('children', []):
            process_node(child)
    
    # Start processing from the root node
    process_node(topic_json["knowledgeTree"])

    with open("knowledge.json", 'w', encoding='utf-8') as f:
        json.dump(topic_json, f, indent=2, ensure_ascii=False)

    return topic_json    

def external_generate(topic, anthropic_key = os.environ.get("ANTHROPIC_API_KEY"), pexels_key = os.environ.get("PEXELS_API_KEY"),   source_text="", source_only=False):

    if not anthropic_key:
        print("Error: ANTHROPIC_API_KEY environment variable not set.")
        print("Please set it with: export ANTHROPIC_API_KEY='your-api-key'")
        sys.exit(1)
    
    print(f"Generating JSON for topic: {topic}")
    print("Loading reference file...")
    
    # Load reference JSON
    reference_json = load_reference_file("reference.json")
    
    print("Generating similar content using Claude API...")
    
    # Generate similar JSON using Claude
    generated_json = generate_similar_json(topic, reference_json, anthropic_key)
    

    print("Inserting media into the generated JSON...")
    # now find images and videos relevant to the topic
    final_json = media_insert(generated_json, anthropic_key, pexels_key)

    return final_json

def main():
    # Check command line arguments
    if len(sys.argv) != 2:
        print("Usage: python generate_json.py <topic>")
        print("Example: python generate_json.py 'machine learning'")
        sys.exit(1)
    
    topic = sys.argv[1]
    

    # Get API key from environment variable
    api_key = os.environ.get("ANTHROPIC_API_KEY")

    if not api_key:
        print("Error: ANTHROPIC_API_KEY environment variable not set.")
        print("Please set it with: export ANTHROPIC_API_KEY='your-api-key'")
        sys.exit(1)
    
    print(f"Generating JSON for topic: {topic}")
    print("Loading reference file...")
    
    # Load reference JSON
    reference_json = load_reference_file("/Users/lordkersting/neuro/code/canvas-cleared/data/reference.json")
    
    print("Generating similar content using Claude API...")
    
    # Generate similar JSON using Claude
    generated_json = generate_similar_json(topic, reference_json, api_key)
    
    print("Generation complete. Saving output file...")
    # Save to output file
    save_output_file(generated_json, "/Users/lordkersting/neuro/code/canvas-cleared/data/knowledge.json")

    print("Inserting media into the generated JSON...")
    # now find images and videos relevant to the topic
    media_insert(topic, "/Users/lordkersting/neuro/code/canvas-cleared/data/knowledge.json", api_key)

if __name__ == "__main__":
    main()