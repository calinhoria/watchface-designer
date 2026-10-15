'use strict';
// FaceProject XML serialize (matches XiaomiWatch.Common FaceProject.Serialize shape names/attrs)
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function widgetAttrs(w) {
  const base = ` Shape="${w.Shape}" Name="${esc(w.Name)}" X="${w.X || 0}" Y="${w.Y || 0}" Width="${w.Width || 0}" Height="${w.Height || 0}" Alpha="${w.Alpha ?? 255}" Visible_Src="0"`;
  switch (w.Shape) {
    case 30: return base + ` Bitmap="${esc(w.Bitmap || '')}"`;
    case 31: return base + ` Index_Src="${esc(w.DataSrcIndex || '')}" DefaultIndex="${w.DefaultIndex ?? 0}" BitmapList="${esc(w.BitmapList || '')}"`;
    case 32: return base + ` Digits="${w.Digits ?? 1}" Alignment="${w.Alignment ?? 0}" Spacing="${w.Spacing ?? 0}" Blanking="${w.Blanking ?? 0}" Value_Src="${esc(w.DataSrcValue || '')}" BitmapList="${esc(w.BitmapList || '')}"`;
    case 27: return base
      + ` HourHandCorrection_En="${w.CorrectionEnableHourHand ?? 0}" MinuteHandCorrection_En="${w.CorrectionEnableMinuteHand ?? 0}"`
      + ` Background_ImageName="${esc(w.BackgroundImage || '')}" BgImage_rotate_xc="${w.BackImageRotateX ?? 0}" BgImage_rotate_yc="${w.BackImageRotateY ?? 0}"`
      + ` HourHand_ImageName="${esc(w.HourHandImage || '')}" HourImage_rotate_xc="${w.HourImageRotateX ?? 0}" HourImage_rotate_yc="${w.HourImageRotateY ?? 0}"`
      + ` MinuteHand_Image="${esc(w.MinuteHandImage || '')}" MinuteImage_rotate_xc="${w.MinuteImageRotateX ?? 0}" MinuteImage_rotate_yc="${w.MinuteImageRotateY ?? 0}"`
      + ` SecondHand_Image="${esc(w.SecondHandImage || '')}" SecondImage_rotate_xc="${w.SecondImageRotateX ?? 0}" SecondImage_rotate_yc="${w.SecondImageRotateY ?? 0}"`;
    case 43: return base
      + ` Range_Max_Src="${w.DataSrcMax ?? 0}" Range_Val_Src="${esc(w.DataSrcVal || '')}" Origo_x="${w.GaugeX ?? 0}" Origo_y="${w.GaugeY ?? 0}"`
      + ` StartAngle="${w.StartAngle ?? 0}" EndAngle="${w.EndAngle ?? 360}" Range_Min="${w.RangeMin ?? 0}" Range_Max="${w.RangeMax ?? 100}"`
      + ` Range_MinStep="${w.RangeMinStep ?? 0}" Range_Step="${w.RangeStep ?? 1}" Pointer_Bitmap="${esc(w.PointerImage || '')}"`
      + ` Pointer_Rotate_xc="${w.PointerRotateX ?? 0}" Pointer_Rotate_yc="${w.PointerRotateY ?? 0}" Render_Height_Quality_En="0"`;
    case 34: return base;
    default: return base + (w.Bitmap ? ` Bitmap="${esc(w.Bitmap)}"` : '') + (w.BitmapList ? ` BitmapList="${esc(w.BitmapList)}"` : '');
  }
}
function widgetTypeName(shape) {
  return shape === 30 ? 'FaceWidgetImage' : shape === 31 ? 'FaceWidgetImageList'
    : shape === 32 ? 'FaceWidgetDigitalNum' : shape === 27 ? 'FaceWidgetAnalogClock'
    : shape === 43 ? 'FaceWidgetCircularGauge' : shape === 34 ? 'FaceWidgetContainer' : 'FaceWidgetImage';
}
function serializeFaceProject(face) {
  let xml = `<?xml version="1.0" encoding="utf-16"?>\r\n<FaceProject DeviceType="${face.DeviceType}">\r\n<Screen Title="${esc(face.Screen.Title)}" Bitmap="${esc(face.Screen.Bitmap)}">`;
  for (const w of face.Screen.Widgets) {
    xml += `\r\n<Widget p3:type="${widgetTypeName(w.Shape)}"${widgetAttrs(w)} xmlns:p3="http://www.w3.org/2001/XMLSchema-instance" />`;
  }
  xml += `\r\n</Screen>\r\n</FaceProject>`;
  return xml;
}
// Minimal fprj parser for re-opening exported projects (attribute-based)
function parseFprj(xml) {
  const dev = /DeviceType="([^"]*)"/.exec(xml)?.[1] ?? '0';
  const title = /<Screen[^>]*Title="([^"]*)"/.exec(xml)?.[1] ?? '';
  const bitmap = /<Screen[^>]*Bitmap="([^"]*)"/.exec(xml)?.[1] ?? 'preview.png';
  const widgets = [];
  const re = /<Widget([^>]*)\/>/g;
  let m;
  const get = (s, n) => new RegExp(n + '="([^"]*)"').exec(s)?.[1];
  while ((m = re.exec(xml))) {
    const s = m[1];
    const Shape = parseInt(get(s, 'Shape') ?? '30', 10);
    const w = {
      Shape, Name: get(s, 'Name') ?? `widget_${widgets.length}`,
      X: parseInt(get(s, 'X') ?? '0', 10), Y: parseInt(get(s, 'Y') ?? '0', 10),
      Width: parseInt(get(s, 'Width') ?? '0', 10), Height: parseInt(get(s, 'Height') ?? '0', 10),
      Alpha: parseInt(get(s, 'Alpha') ?? '255', 10),
    };
    if (Shape === 30) w.Bitmap = get(s, 'Bitmap') ?? '';
    if (Shape === 31) { w.DataSrcIndex = get(s, 'Index_Src') ?? ''; w.DefaultIndex = parseInt(get(s, 'DefaultIndex') ?? '0', 10); w.BitmapList = get(s, 'BitmapList') ?? ''; }
    if (Shape === 32) {
      w.Digits = parseInt(get(s, 'Digits') ?? '1', 10); w.Alignment = parseInt(get(s, 'Alignment') ?? '0', 10);
      w.Spacing = parseInt(get(s, 'Spacing') ?? '0', 10); w.Blanking = parseInt(get(s, 'Blanking') ?? '0', 10);
      w.DataSrcValue = get(s, 'Value_Src') ?? ''; w.BitmapList = get(s, 'BitmapList') ?? '';
    }
    if (Shape === 27) {
      for (const k of ['BackgroundImage', 'HourHandImage', 'MinuteHandImage', 'SecondHandImage']) w[k] = '';
      w.BackgroundImage = get(s, 'Background_ImageName') ?? ''; w.HourHandImage = get(s, 'HourHand_ImageName') ?? '';
      w.MinuteHandImage = get(s, 'MinuteHand_Image') ?? ''; w.SecondHandImage = get(s, 'SecondHand_Image') ?? '';
    }
    if (Shape === 43) { w.DataSrcVal = get(s, 'Range_Val_Src') ?? ''; w.PointerImage = get(s, 'Pointer_Bitmap') ?? ''; }
    widgets.push(w);
  }
  return { DeviceType: parseInt(dev, 10) || 0, Screen: { Title: title, Bitmap: bitmap, Widgets: widgets } };
}
module.exports = { serializeFaceProject, parseFprj };
