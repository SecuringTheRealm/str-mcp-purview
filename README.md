# sealjay-template
> A template for new repositories I create.

```
Add a short description of your project.
DELETE THIS COMMENT
```
<!-- Javascript -->
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)
![GitHub issues](https://img.shields.io/github/issues/Sealjay/sealjay-template)
![GitHub](https://img.shields.io/github/license/Sealjay/sealjay-template)
![GitHub Repo stars](https://img.shields.io/github/stars/Sealjay/sealjay-template?style=social)

<!-- Lang badges -->
[![Go](https://img.shields.io/badge/--3178C6?logo=go&logoColor=ffffff)](https://go.dev/)
[![Docker](https://img.shields.io/badge/--3178C6?logo=docker&logoColor=ffffff)](https://www.docker.com/) 
[![TypeScript](https://img.shields.io/badge/--3178C6?logo=typescript&logoColor=ffffff)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/--3178C6?logo=python&logoColor=ffffff)](https://www.python.org/)
[![JavaScript](https://img.shields.io/badge/--3178C6?logo=javascript&logoColor=ffffff)](https://nodejs.org/en/)

<!-- Cloud badges -->
[![Azure](https://img.shields.io/badge/--3178C6?logo=microsoftazure&logoColor=ffffff)](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/?WT.mc_id=AI-MVP-5004204)

<!-- Package badges -->
[![NextJS](https://img.shields.io/badge/--3178C6?logo=next.js&logoColor=ffffff)](https://nextjs.org/)


```
Update the repo URL addresses for the shield templates.
DELETE THIS COMMENT
```

## Overview
Describe the project in more detail.

This repository is designed to be compiled and deployed to [Azure Static Web Apps](https://docs.microsoft.com/en-us/azure/static-web-apps/deploy-nextjs?WT.mc_id=AI-MVP-5004204).


## Licensing
<!-- MIT -->
sealjay-template is available under the [MIT Licence](./LICENCE).and is freely available to End Users
<!-- Tailwind template -->
The underlying site template is a commercial product and is licensed under the [Tailwind UI license](https://tailwindui.com/license). Changes and additions are licenced under the MIT licence, as an End Product released open source and freely available to End Users

```
Update the project name.
DELETE THIS COMMENT
```

## Solutions Referenced
- [Infrastructure as code in Bicep](https://docs.microsoft.com/en-us/azure/azure-resource-manager/bicep/overview?&WT.mc_id=AI-MVP-500420)


```
These are provided as examples. Include links to components you have used, or delete this section.
DELETE THIS COMMENT
```

## Documentation
The `docs` folder contains [more detailed documentation](./docs/start-here.md), along with setup instructions.

```
Add an optional installation or usage section, if the instructions are short.
e.g.
## Getting started with this repository
You can use a [dev container](https://docs.microsoft.com/en-us/azure-sphere/app-development/container-build-vscode?&WT.mc_id=AI-MVP-500420) to run this in VS Code, or in [GitHub codespaces](https://github.com/features/codespaces).
<!-- SWA -->
To get started, first install the [Azure Static Web App CLI](https://azure.github.io/static-web-apps-cli/docs/use/install), and make sure you have nodejs installed.

### Run the development server:

```bash
swa start
```

Finally, open [http://localhost:3000](http://localhost:3000) in your browser to view the website.
<!-- Python -->
### Review the research notebook
The notebook uses Jupyter (not jupyterlabs.)
1. Update conda: `conda update conda`
2. Create the environment (Call it thinkdays-space) `conda create -c conda-forge -n thinkdays-space python=3.10 rise pip`
3. Activate the environment: `source activate thinkdays-space`
4. Install all required packages: `pip install -r requirements.txt`.
5. Get some space back: `conda clean -a`
6. Start the notebook server: `jupyter notebook`

### Cloud Resources
You'll need to deploy an [Azure Cognitive Search](https://docs.microsoft.com/en-us/azure/search/search-what-is-azure-search?WT.mc_id=AI-MVP-5004204) resource; and an Azure App Service if you want to host this. Right now, the [Bicep file](https://docs.microsoft.com/en-us/azure/azure-resource-manager/bicep/overview?&WT.mc_id=AI-MVP-500420) is not complete.

### Installation

### Usage

DELETE THIS COMMENT
```

## Contact
Feel free to contact me [on Twitter](https://twitter.com/sealjay_clj). For bugs, please [raise an issue on GitHub](https://github.com/Sealjay/sealjay-template/issue).
```
Update the repo URL.
DELETE THIS COMMENT
```
## Contributing
Contributions are more than welcome! This repository uses [GitHub flow](https://guides.github.com/introduction/flow/) - with [Commitizen](https://github.com/commitizen/cz-cli#making-your-repo-commitizen-friendly) to enforce semantic commits (`npm install -g commitizen cz-customizable`, `echo '{ "path": "cz-customizable" }' > ~/.czrc`, and then `git cz`- easy to setup!)

**Note: This adds a .czrc file to your home directory, and will overwrite existing commitzen .czrc files.**

```
DELETE THIS COMMENT
```
