import { useEffect, useState } from 'react'
import './App.css'

const API_BASE_URL = 'http://localhost:3001'

function App() {
  const [rootDirectory, setRootDirectory] = useState('')
  const [currentDirectory, setCurrentDirectory] = useState('')
  const [parentDirectory, setParentDirectory] = useState('')
  const [entries, setEntries] = useState([])
  const [selectedImagePaths, setSelectedImagePaths] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const normalizePath = (pathValue) => pathValue.trim().replace(/[\\/]+$/, '').toLowerCase()

  const isAtRootDirectory =
    Boolean(rootDirectory) && normalizePath(currentDirectory) === normalizePath(rootDirectory)

  const canGoBack = Boolean(parentDirectory) && !isAtRootDirectory

  const getEntryIcon = (type) => {
    if (type === 'directory') {
      return '📁'
    }

    return '🖼️'
  }

  const fetchEntries = async (targetPath = '') => {
    try {
      setIsLoading(true)
      setError('')

      const url = new URL('/api/directories', API_BASE_URL)

      if (targetPath) {
        url.searchParams.set('path', targetPath)
      }

      const response = await fetch(url)

      if (!response.ok) {
        throw new Error('Falha ao carregar itens.')
      }

      const data = await response.json()
      setRootDirectory(data.basePath || '')
      setCurrentDirectory(data.currentDirectory || data.basePath || '')
      setParentDirectory(data.parentDirectory || '')

      if (Array.isArray(data.entries)) {
        setEntries(data.entries)
      } else if (Array.isArray(data.directories)) {
        setEntries(data.directories.map((directory) => ({ ...directory, type: 'directory' })))
      } else {
        setEntries([])
      }
    } catch {
      setError('Não foi possível carregar os itens.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleDirectoryClick = (entry) => {
    if (entry.type !== 'directory') {
      return
    }

    fetchEntries(entry.path)
  }

  const handleBackClick = () => {
    if (!canGoBack) {
      return
    }

    fetchEntries(parentDirectory)
  }

  const isImageSelected = (imagePath) => selectedImagePaths.includes(imagePath)

  const handleImageSelectionChange = (imagePath, checked) => {
    setSelectedImagePaths((previousPaths) => {
      if (checked) {
        if (previousPaths.includes(imagePath)) {
          return previousPaths
        }

        return [...previousPaths, imagePath]
      }

      return previousPaths.filter((path) => path !== imagePath)
    })
  }

  const handleDownloadSelected = async () => {
    if (selectedImagePaths.length === 0) {
      return
    }

    try {
      const response = await fetch(new URL('/api/download', API_BASE_URL), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          paths: selectedImagePaths,
        }),
      })

      if (!response.ok) {
        throw new Error('Falha no download')
      }

      const blob = await response.blob()
      const downloadUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = 'images.zip'
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(downloadUrl)
    } catch {
      setError('Não foi possível baixar o arquivo ZIP.')
    }
  }

  useEffect(() => {
    fetchEntries()
  }, [])

  return (
    <div className="app-container">
      <header className="top-bar">
        <button
          type="button"
          className="back-button"
          disabled={!canGoBack || isLoading}
          onClick={handleBackClick}
        >
          ← Retornar
        </button>
        <span className="app-name">imageServer</span>
      </header>

      <main className="content">
        <p className="current-directory">
          Diretório atual: {currentDirectory || 'Documents'}
        </p>

        {isLoading && <p>Carregando itens...</p>}
        {error && <p>{error}</p>}

        {!isLoading && !error && (
          <div className="content-layout">
            <section>
              <ul className="directory-list">
                {entries.map((entry) => (
                  <li key={entry.path} className="directory-item">
                    <span className="entry-icon">{getEntryIcon(entry.type)}</span>
                    {entry.type === 'directory' ? (
                      <button
                        type="button"
                        className="entry-button"
                        onClick={() => handleDirectoryClick(entry)}
                      >
                        {entry.name}
                      </button>
                    ) : (
                      <div className="image-entry">
                        <input
                          type="checkbox"
                          checked={isImageSelected(entry.path)}
                          onChange={(event) =>
                            handleImageSelectionChange(entry.path, event.target.checked)
                          }
                        />
                        <img
                          src={`${API_BASE_URL}${entry.thumbnailUrl}`}
                          alt={entry.name}
                          className="image-thumb"
                          loading="lazy"
                        />
                        <span>{entry.name}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <aside className="selected-panel-wrapper">
              <div className="selected-panel">
                <p className="selected-title">Imagens selecionadas</p>
                {selectedImagePaths.length === 0 ? (
                  <p>Nenhuma imagem selecionada.</p>
                ) : (
                  <ul className="selected-list">
                    {selectedImagePaths.map((imagePath) => (
                      <li key={imagePath}>{imagePath}</li>
                    ))}
                  </ul>
                )}
              </div>

              <button
                type="button"
                className="download-button"
                disabled={selectedImagePaths.length === 0}
                onClick={handleDownloadSelected}
              >
                Download ZIP
              </button>
            </aside>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
