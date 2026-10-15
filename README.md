
# Experimental Code for Tree-Based Immersive Presentations

## To run in your own environment
MAC OS:

$ npm install

$ npm run dev

Then open a browser and navigate to http://localhost:8080/.

## To make your own presentation
1. Start crafting your own version of data/knowledge.json (an LLM can typically make this for you just by giving it the default example here and telling it what you want the talk to be about) and add a directory to data/examples to store your images, following the structure there. Hopefully the schema is self-explanatory.
2. Copy your main JSON file to data/knowledge.json and it should just work.
3. You will probably want to post-edit: add/fix images and links, adjust wording, editing nodes, etc. Give it your own touch.
4. Use an IDE such as VS Code with an AI Assistant (like Github Copilot) to make your life much easier. It can help you auto-complete nodes and widgets as you go.
5. Note if you're publishing this with Lovable (see below) you'll want to update your knowledge.json to reference images in the /public directory of your GitHub root. So if your images are in data/examples/MyProject you'll want to move them all to /public/examples/MyProject and add a '/' in front of all your file references.

-----------------------------------------------------

 © 2025 Iron Action AI, LLC. All rights reserved.
   
   This software is patent pending. For licensing inquiries, 
   contact: Nicholas Kersting / 1054h34@gmail.com


   
# Lovable project info below:

## Project info

**URL**: https://lovable.dev/projects/ee225e0a-a674-4085-b114-0dbd7e514f31

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://lovable.dev/projects/ee225e0a-a674-4085-b114-0dbd7e514f31) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## How can I deploy this project?

Simply open [Lovable](https://lovable.dev/projects/ee225e0a-a674-4085-b114-0dbd7e514f31) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/tips-tricks/custom-domain#step-by-step-guide)
