package ocr

import "math"

var textishColumnLabels = map[string]bool{
	"abstract": true, "aside_text": true, "doc_title": true, "figure_title": true,
	"footnote": true, "header": true, "number": true, "paragraph_title": true,
	"reference_content": true, "text": true, "vision_footnote": true,
}

var nonBodyColumnLabels = map[string]bool{
	"aside_text": true, "footnote": true, "footer": true, "footer_image": true,
	"header": true, "header_image": true, "number": true, "vision_footnote": true,
}

// annotateColumnSignals follows LeePDF's Paddle page signal pass. Empty OCR
// text blocks are retained in MapLayouts because their geometry can reveal an
// omitted peer column or text absorbed into the adjacent block.
func annotateColumnSignals(page *Page) {
	if page == nil {
		return
	}
	width := page.Width
	leftCenters, rightCenters := []float64{}, []float64{}
	leftSlots, rightSlots, hasEmptySideSlot := 0, 0, false
	for i := range page.Blocks {
		block := &page.Blocks[i]
		block.ColumnIndexGuess = columnGuess(block.Box, width)
		if textishColumnLabels[block.Label] && block.ColumnIndexGuess == "left" && isColumnSized(block.Box, width) {
			leftSlots++
		}
		if textishColumnLabels[block.Label] && block.ColumnIndexGuess == "right" && isColumnSized(block.Box, width) {
			rightSlots++
		}
		if len([]rune(block.Text)) < 2 && (block.ColumnIndexGuess == "left" || block.ColumnIndexGuess == "right") {
			hasEmptySideSlot = true
		}
		if !textishColumnLabels[block.Label] || block.Text == "" || width <= 0 || !isColumnSized(block.Box, width) {
			continue
		}
		center := (block.Box[0] + block.Box[2]) / 2
		if block.ColumnIndexGuess == "left" {
			leftCenters = append(leftCenters, center)
		} else if block.ColumnIndexGuess == "right" {
			rightCenters = append(rightCenters, center)
		}
	}
	mode, split := "single", width/2
	if width <= 0 {
		mode, split = "unknown", 0
	} else if (len(leftCenters) >= 2 && len(rightCenters) >= 2) || (leftSlots >= 2 && rightSlots >= 2) || (leftSlots >= 1 && rightSlots >= 1 && hasEmptySideSlot) {
		mode = "double"
		if len(leftCenters) > 0 && len(rightCenters) > 0 {
			split = (median(leftCenters) + median(rightCenters)) / 2
		}
	}
	page.ColumnLayoutMode = mode
	page.ColumnSplitX = split
	for index := range page.Blocks {
		page.Blocks[index].ColumnLayoutMode = mode
	}
	if mode != "double" {
		return
	}
	for currentIndex := range page.Blocks {
		current := page.Blocks[currentIndex]
		if len([]rune(current.Text)) < 2 || (current.ColumnIndexGuess != "left" && current.ColumnIndexGuess != "right") || nonBodyColumnLabels[current.Label] {
			continue
		}
		for neighborIndex := range page.Blocks {
			neighborOrder := page.Blocks[neighborIndex].SourceOrder
			if current.HasSourceOrder && page.Blocks[neighborIndex].HasSourceOrder {
				if neighborOrder != current.SourceOrder-1 && neighborOrder != current.SourceOrder+1 {
					continue
				}
			} else if neighborIndex != currentIndex-1 && neighborIndex != currentIndex+1 {
				continue
			}
			neighbor := page.Blocks[neighborIndex]
			if len([]rune(neighbor.Text)) >= 2 || nonBodyColumnLabels[neighbor.Label] || neighbor.ColumnIndexGuess == current.ColumnIndexGuess || (neighbor.ColumnIndexGuess != "left" && neighbor.ColumnIndexGuess != "right") || !verticalOverlap(current.Box, neighbor.Box) {
				continue
			}
			current.CrossColumnMergeSuspected = true
			current.ReadingOrderUnreliable = true
			current.StructureUnreliable = true
			current.PeerBlockAbsorbedText = true
			current.SuspectedPeerBlockID = neighbor.ID
			neighbor.CrossColumnMergeSuspected = true
			neighbor.ReadingOrderUnreliable = true
			neighbor.StructureUnreliable = true
			neighbor.TextMissingButBBoxPresent = true
			neighbor.SuspectedPeerBlockID = current.ID
			page.Blocks[neighborIndex] = neighbor
		}
		page.Blocks[currentIndex] = current
	}
}

func columnGuess(box [4]float64, pageWidth float64) string {
	if pageWidth <= 0 {
		return "unknown"
	}
	if box[2]-box[0] >= pageWidth*0.62 {
		return "full"
	}
	if (box[0]+box[2])/2 <= pageWidth/2 {
		return "left"
	}
	return "right"
}

func isColumnSized(box [4]float64, pageWidth float64) bool {
	if pageWidth <= 0 {
		return false
	}
	ratio := (box[2] - box[0]) / pageWidth
	return ratio >= 0.18 && ratio <= 0.48
}

func verticalOverlap(a, b [4]float64) bool {
	overlap := math.Min(a[3], b[3]) - math.Max(a[1], b[1])
	minHeight := math.Min(math.Max(1, a[3]-a[1]), math.Max(1, b[3]-b[1]))
	return overlap >= minHeight*0.25
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	copyValues := append([]float64(nil), values...)
	for i := 1; i < len(copyValues); i++ {
		for j := i; j > 0 && copyValues[j] < copyValues[j-1]; j-- {
			copyValues[j], copyValues[j-1] = copyValues[j-1], copyValues[j]
		}
	}
	middle := len(copyValues) / 2
	if len(copyValues)%2 == 1 {
		return copyValues[middle]
	}
	return (copyValues[middle-1] + copyValues[middle]) / 2
}
